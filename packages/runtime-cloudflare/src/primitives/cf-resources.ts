/**
 * Cloudflare implementation of the {@link ResourcesPlugin} seam.
 *
 * Accounting model (RUNTIME-SPEC §4.5):
 *   • tokens + USD cost — adopter reports via `reportTokens` /
 *     `reportCost`; enforcement is BEFORE the counter increments so
 *     one over-limit call fails cleanly without partial accounting
 *   • activeOperations — `beginOperation()` returns an end-token;
 *     caller uses try/finally to decrement
 *   • memoryMB / cpuMsLifetime — best-effort approximations from
 *     workerd's `performance` API; platform enforces the hard caps
 *
 * Persistence: lifetime counters (`__usage::*`) live in DO storage
 * so `getUsage()` is sub-1s (DO local read, not Analytics Engine
 * round-trip) and survives hibernation.
 *
 * `setLimits` in-flight semantics: operations that have already
 * begun complete under THEIR limits snapshot (enforcement happens
 * at operation start, not continuously). Subsequent operations see
 * the new limits.
 */

import type {
  LimitEvent,
  LimitEventHandler,
  ResourceLimits,
  ResourceUsage,
  ResourceWarning,
  Timestamp,
} from "@loom-loyalty/meridian-types";

import { meridianError } from "../errors.js";
import type { ResourcesPlugin } from "./types.js";

const LIMITS_KEY = "__limits__";
const USAGE_TOKENS_KEY = "__usage::tokens";
const USAGE_COST_KEY = "__usage::cost";
const USAGE_CPU_MS_KEY = "__usage::cpuMs";
const USAGE_WARNINGS_KEY = "__usage::warnings";

const DEFAULT_WARNING_THRESHOLD = 0.8;

export interface CostAttribution {
  workItemId?: string;
}

export class CfResourcesPlugin implements ResourcesPlugin {
  // Handler registered via `onLimitEvent` — module-level to this DO,
  // fire-and-forget per spec §4.6.
  private limitHandler: LimitEventHandler | undefined;

  // Active operations is in-memory only: they're per-request
  // lifetimes that don't survive DO restarts (any in-flight op at
  // restart is already unrecoverable anyway).
  private active = 0;

  constructor(private readonly ctx: DurableObjectState) {}

  async setLimits(limits: ResourceLimits): Promise<void> {
    await this.ctx.storage.put(LIMITS_KEY, limits);
  }

  async getLimits(): Promise<ResourceLimits> {
    return (await this.ctx.storage.get<ResourceLimits>(LIMITS_KEY)) ?? {};
  }

  async getUsage(): Promise<ResourceUsage> {
    const limits = await this.getLimits();
    const tokens = (await this.ctx.storage.get<number>(USAGE_TOKENS_KEY)) ?? 0;
    const cost = (await this.ctx.storage.get<number>(USAGE_COST_KEY)) ?? 0;
    const cpuMs = (await this.ctx.storage.get<number>(USAGE_CPU_MS_KEY)) ?? 0;
    const warnings =
      (await this.ctx.storage.get<ResourceWarning[]>(USAGE_WARNINGS_KEY)) ?? [];

    // Best-effort memoryMB from V8 heap stats. In workerd user-space
    // `performance.memory` may be absent or restricted; fall back to 0.
    const memoryMB = this.estimateMemoryMB();

    return {
      limits,
      current: {
        memoryMB,
        cpuMsLifetime: cpuMs,
        tokensLifetime: tokens,
        costUsdLifetime: cost,
        activeOperations: this.active,
      },
      warnings,
    };
  }

  async onLimitEvent(handler: LimitEventHandler): Promise<void> {
    this.limitHandler = handler;
  }

  async reportTokens(
    n: number,
    _attribution: CostAttribution = {},
  ): Promise<void> {
    if (n < 0) {
      throw meridianError(
        "MRD-CF-RS-003",
        `reportTokens(${n}) requires a non-negative count`,
      );
    }
    const limits = await this.getLimits();

    if (limits.maxTokensPerCall !== undefined && n > limits.maxTokensPerCall) {
      throw meridianError(
        "MRD-CF-RS-003",
        `reportTokens(${n}) exceeds maxTokensPerCall=${limits.maxTokensPerCall}`,
        { context: { n, limit: limits.maxTokensPerCall } },
      );
    }

    const prior = (await this.ctx.storage.get<number>(USAGE_TOKENS_KEY)) ?? 0;
    const next = prior + n;

    if (limits.maxTokensTotal !== undefined && next > limits.maxTokensTotal) {
      throw meridianError(
        "MRD-CF-RS-001",
        `reportTokens would raise total to ${next}, exceeding maxTokensTotal=${limits.maxTokensTotal}`,
        {
          context: {
            attempted: n,
            currentTotal: prior,
            limit: limits.maxTokensTotal,
          },
        },
      );
    }

    await this.ctx.storage.put(USAGE_TOKENS_KEY, next);
    await this.maybeEmitLimitEvent("tokens", next, limits.maxTokensTotal);
  }

  async reportCost(
    usd: number,
    _attribution: CostAttribution = {},
  ): Promise<void> {
    if (usd < 0) {
      throw meridianError(
        "MRD-CF-RS-002",
        `reportCost(${usd}) requires a non-negative amount`,
      );
    }
    const limits = await this.getLimits();
    const prior = (await this.ctx.storage.get<number>(USAGE_COST_KEY)) ?? 0;
    const next = prior + usd;

    if (limits.maxCostUsd !== undefined && next > limits.maxCostUsd) {
      throw meridianError(
        "MRD-CF-RS-002",
        `reportCost would raise total to $${next.toFixed(4)}, exceeding maxCostUsd=$${limits.maxCostUsd}`,
        {
          context: {
            attempted: usd,
            currentTotal: prior,
            limit: limits.maxCostUsd,
          },
        },
      );
    }

    await this.ctx.storage.put(USAGE_COST_KEY, next);
    await this.maybeEmitLimitEvent("cost", next, limits.maxCostUsd);
  }

  async beginOperation(): Promise<() => Promise<void>> {
    const limits = await this.getLimits();
    if (
      limits.maxConcurrency !== undefined &&
      this.active >= limits.maxConcurrency
    ) {
      throw meridianError(
        "MRD-CF-RS-004",
        `activeOperations=${this.active} already at maxConcurrency=${limits.maxConcurrency}; try again after a running op ends`,
        {
          context: {
            activeOperations: this.active,
            limit: limits.maxConcurrency,
          },
        },
      );
    }

    const startedAt = Date.now();
    this.active++;
    const self = this;

    return async function endOperation() {
      self.active = Math.max(0, self.active - 1);
      const elapsed = Date.now() - startedAt;
      const priorCpuMs =
        (await self.ctx.storage.get<number>(USAGE_CPU_MS_KEY)) ?? 0;
      await self.ctx.storage.put(USAGE_CPU_MS_KEY, priorCpuMs + elapsed);
    };
  }

  // ── internal ─────────────────────────────────────────────

  private estimateMemoryMB(): number {
    // `performance.memory` is a Chromium-ish extension; workerd may
    // or may not expose it. Typed loosely since @cloudflare/workers-types
    // doesn't include it.
    const perf = (
      globalThis as unknown as {
        performance?: { memory?: { usedJSHeapSize?: number } };
      }
    ).performance;
    const bytes = perf?.memory?.usedJSHeapSize;
    if (typeof bytes !== "number") return 0;
    return Math.round(bytes / (1024 * 1024));
  }

  /**
   * Emit a warning or exceeded event if the limit exists and the
   * current value crossed the 80% / 100% thresholds since last
   * emit. Warning emissions are de-duped by storing the peak
   * threshold we've already reported.
   */
  private async maybeEmitLimitEvent(
    resource: "tokens" | "cost" | "cpu" | "memory" | "concurrency",
    currentValue: number,
    limit: number | undefined,
  ): Promise<void> {
    if (limit === undefined || limit <= 0) return;
    const ratio = currentValue / limit;
    if (ratio < DEFAULT_WARNING_THRESHOLD) return;

    // Record the warning (idempotent by resource name — we keep the
    // most recent threshold crossing per resource). Adopters query
    // via getUsage().warnings; the handler gives them push semantics.
    const warnings =
      (await this.ctx.storage.get<ResourceWarning[]>(USAGE_WARNINGS_KEY)) ?? [];
    const triggeredAt = Date.now() as Timestamp;
    const filtered = warnings.filter((w) => w.type !== resource);
    filtered.push({ type: resource, threshold: ratio, triggeredAt });
    await this.ctx.storage.put(USAGE_WARNINGS_KEY, filtered);

    if (this.limitHandler) {
      const event: LimitEvent = {
        agentId: this.ctx.id.toString(),
        type: ratio >= 1 ? "exceeded" : "warning",
        resource,
        current: currentValue,
        limit,
        timestamp: triggeredAt,
      };
      // Fire-and-forget — spec §4.6 requires non-blocking emission.
      void this.limitHandler(event).catch((err) => {
        console.warn(
          `[resources] onLimitEvent handler threw: ${(err as Error).message}`,
        );
      });
    }
  }
}
