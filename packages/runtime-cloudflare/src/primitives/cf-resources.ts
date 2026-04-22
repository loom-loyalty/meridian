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

// Per-workItemId attribution keys, populated when adopters pass
// `{workItemId}` to `reportTokens` / `reportCost`. Lives under a
// distinct prefix so list({prefix:"__usage_wi::"}) can enumerate
// all work-item breakdowns without scanning the full storage.
const USAGE_WI_TOKENS_PREFIX = "__usage_wi_tokens::";
const USAGE_WI_COST_PREFIX = "__usage_wi_cost::";

export interface WorkItemUsage {
  workItemId: string;
  tokens: number;
  costUsd: number;
}

const DEFAULT_WARNING_THRESHOLD = 0.8;

export interface CostAttribution {
  workItemId?: string;
}

const TERMINATED_KEY = "__terminated__";

export interface CfResourcesPluginOptions {
  /**
   * Optional sink for throws from adopter-registered
   * {@link LimitEventHandler}s. The plugin catches those throws so
   * one bad handler cannot poison later handlers; the hosting DO
   * plugs this callback in to route them through the same
   * `meridian.hook.errors` observability surface as
   * `onSpawn` / `onMessage` / `onSchedule` / `onTerminate` throws.
   *
   * When omitted, the plugin falls back to `console.warn` so
   * standalone tests don't silently swallow handler bugs.
   */
  onHandlerError?: (err: Error) => void | Promise<void>;
}

export class CfResourcesPlugin implements ResourcesPlugin {
  // Multiple handlers are allowed — adopters composing libraries
  // shouldn't have a silent "last-registered-wins" footgun. Each
  // call to `onLimitEvent` appends; there's no unregister API in
  // v0.1 (handlers live for the DO's lifetime). Fire-and-forget
  // per spec §4.6.
  private limitHandlers: LimitEventHandler[] = [];

  // Active operations is in-memory only: they're per-request
  // lifetimes that don't survive DO restarts (any in-flight op at
  // restart is already unrecoverable anyway).
  private active = 0;

  private readonly onHandlerError?: (err: Error) => void | Promise<void>;

  constructor(
    private readonly ctx: DurableObjectState,
    opts: CfResourcesPluginOptions = {},
  ) {
    this.onHandlerError = opts.onHandlerError;
  }

  async setLimits(limits: ResourceLimits): Promise<void> {
    await this.ctx.storage.put(LIMITS_KEY, limits);
  }

  async getLimits(): Promise<ResourceLimits> {
    return (await this.ctx.storage.get<ResourceLimits>(LIMITS_KEY)) ?? {};
  }

  async getUsage(): Promise<ResourceUsage> {
    // Batched get returns a snapshot-consistent view across all
    // usage keys — 4 sequential `get`s could interleave with a
    // concurrent reportTokens/reportCost write (serialized by the
    // DO input gate, but still a torn read from the caller's
    // perspective if we don't batch). One round-trip, one
    // transactional snapshot.
    const snap = await this.ctx.storage.get<
      number | ResourceLimits | ResourceWarning[]
    >([
      LIMITS_KEY,
      USAGE_TOKENS_KEY,
      USAGE_COST_KEY,
      USAGE_CPU_MS_KEY,
      USAGE_WARNINGS_KEY,
    ]);

    const limits = (snap.get(LIMITS_KEY) as ResourceLimits | undefined) ?? {};
    const tokens = (snap.get(USAGE_TOKENS_KEY) as number | undefined) ?? 0;
    const cost = (snap.get(USAGE_COST_KEY) as number | undefined) ?? 0;
    const cpuMs = (snap.get(USAGE_CPU_MS_KEY) as number | undefined) ?? 0;
    const warnings =
      (snap.get(USAGE_WARNINGS_KEY) as ResourceWarning[] | undefined) ?? [];

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
    this.limitHandlers.push(handler);
  }

  async reportTokens(
    n: number,
    attribution: CostAttribution = {},
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

    // RUNTIME-SPEC §4.5: "runtime must attribute the cost to that
    // workItemId in addition to the agent's lifetime total." We
    // shard per-workItem under a distinct prefix so breakdowns are
    // retrievable without scanning the main usage keys.
    if (attribution.workItemId) {
      const wiKey = `${USAGE_WI_TOKENS_PREFIX}${attribution.workItemId}`;
      const priorWi = (await this.ctx.storage.get<number>(wiKey)) ?? 0;
      await this.ctx.storage.put(wiKey, priorWi + n);
    }

    await this.maybeEmitLimitEvent("tokens", next, limits.maxTokensTotal);
  }

  async reportCost(
    usd: number,
    attribution: CostAttribution = {},
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

    if (attribution.workItemId) {
      const wiKey = `${USAGE_WI_COST_PREFIX}${attribution.workItemId}`;
      const priorWi = (await this.ctx.storage.get<number>(wiKey)) ?? 0;
      await this.ctx.storage.put(wiKey, priorWi + usd);
    }

    await this.maybeEmitLimitEvent("cost", next, limits.maxCostUsd);
  }

  /**
   * Read the per-workItemId usage breakdown. If `workItemId` is
   * omitted, returns an entry for every work item that has ever
   * received an attributed token or cost report. Returns an empty
   * array when no attribution has been recorded. Sub-1s per
   * RUNTIME-SPEC §4.5 because it reads directly from DO storage.
   */
  async getUsageByWorkItem(workItemId?: string): Promise<WorkItemUsage[]> {
    if (workItemId) {
      const tokens =
        (await this.ctx.storage.get<number>(
          `${USAGE_WI_TOKENS_PREFIX}${workItemId}`,
        )) ?? 0;
      const costUsd =
        (await this.ctx.storage.get<number>(
          `${USAGE_WI_COST_PREFIX}${workItemId}`,
        )) ?? 0;
      if (tokens === 0 && costUsd === 0) return [];
      return [{ workItemId, tokens, costUsd }];
    }

    const [tokensMap, costMap] = await Promise.all([
      this.ctx.storage.list<number>({ prefix: USAGE_WI_TOKENS_PREFIX }),
      this.ctx.storage.list<number>({ prefix: USAGE_WI_COST_PREFIX }),
    ]);

    const ids = new Set<string>();
    for (const k of tokensMap.keys()) {
      ids.add(k.slice(USAGE_WI_TOKENS_PREFIX.length));
    }
    for (const k of costMap.keys()) {
      ids.add(k.slice(USAGE_WI_COST_PREFIX.length));
    }

    const result: WorkItemUsage[] = [];
    for (const id of ids) {
      result.push({
        workItemId: id,
        tokens: tokensMap.get(`${USAGE_WI_TOKENS_PREFIX}${id}`) ?? 0,
        costUsd: costMap.get(`${USAGE_WI_COST_PREFIX}${id}`) ?? 0,
      });
    }
    // Stable ordering: most-spent first.
    result.sort((a, b) => b.costUsd - a.costUsd);
    return result;
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
      // Guard against post-terminate writes. If the DO was wiped
      // while this operation was in-flight, the TERMINATED_KEY
      // sentinel is set and the usage counter would be orphan
      // state on the empty DO. Skip the write; the CPU time for
      // a terminated agent is meaningless anyway.
      const terminated = await self.ctx.storage.get<boolean>(TERMINATED_KEY);
      if (terminated) return;
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

    // Record the warning. Cap the list at one entry per resource
    // TYPE (tokens / cost / cpu / memory / concurrency) so the
    // array stays bounded — we overwrite any prior entry for the
    // same type with the latest crossing, not the peak. Adopters
    // query via `getUsage().warnings`; `onLimitEvent` gives push
    // semantics for same-tick reactions.
    const warnings =
      (await this.ctx.storage.get<ResourceWarning[]>(USAGE_WARNINGS_KEY)) ?? [];
    const triggeredAt = Date.now() as Timestamp;
    const filtered = warnings.filter((w) => w.type !== resource);
    filtered.push({ type: resource, threshold: ratio, triggeredAt });
    await this.ctx.storage.put(USAGE_WARNINGS_KEY, filtered);

    if (this.limitHandlers.length === 0) return;
    const event: LimitEvent = {
      agentId: this.ctx.id.toString(),
      type: ratio >= 1 ? "exceeded" : "warning",
      resource,
      current: currentValue,
      limit,
      timestamp: triggeredAt,
    };
    // Fire-and-forget per spec §4.6 — non-blocking emission. Each
    // handler is independently caught so one bad handler can't
    // prevent later ones from seeing the event. The hosting DO
    // routes throws through the `meridian.hook.errors` surface
    // via `onHandlerError`; standalone tests fall back to
    // `console.warn`.
    for (const handler of this.limitHandlers) {
      void handler(event).catch((err) => {
        if (this.onHandlerError) {
          try {
            void this.onHandlerError(err as Error);
          } catch {
            // callback must never cascade — swallow defensively
          }
        } else {
          console.warn(
            `[resources] onLimitEvent handler threw: ${(err as Error).message}`,
          );
        }
      });
    }
  }
}
