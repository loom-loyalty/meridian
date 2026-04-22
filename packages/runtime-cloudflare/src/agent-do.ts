/**
 * AgentDurableObject — composed plugin surface.
 *
 * One DO instance per spawned agent (`env.AGENT.idFromName(agentId)`).
 * This class is the RPC boundary Miniflare and real CF both speak;
 * it delegates every method to the matching internal plugin
 * (`CfLifecyclePlugin`, `CfStatePlugin`, `CfSchedulingPlugin`,
 * `CfTransportPlugin`), and invokes adopter-supplied hooks from
 * the `AgentSpec` registered via `defineAgent()` at the right
 * points (post-spawn, post-deliver, pre-terminate).
 *
 * Primitives implemented in M2c:
 *   • Lifecycle — spawn / suspend / resume / terminate / get / exists
 *                 (+ snapshotState @experimental → UNAVAILABLE,
 *                  + identity guard MRD-CF-LC-005)
 *   • State     — save / load / delete / list / incrementAtomic
 *   • Scheduling — scheduleAt / scheduleCron / cancelSchedule /
 *                  listSchedules / drainFiredSchedules (cron
 *                  coalesce + alarm-backed)
 *   • Transport — send / broadcast / deliver / receiveAll / drainAll
 *                 (sender-partitioned mailbox, 1 MB limit, hooks)
 *
 * Resources + Observability land in M2d.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  AgentHandle,
  AgentId,
  AgentSelector,
  BroadcastReceipt,
  IncomingMessage,
  ListOptions,
  ListResult,
  MessageReceipt,
  ResourceLimits,
  ResourceUsage,
  ScheduleId,
  ScheduleInfo,
  SpawnConfig,
  Timestamp,
} from "@loom-loyalty/meridian-types";

import { getAgentSpec, type AgentContext } from "./define-agent.js";
import { meridianError } from "./errors.js";
import {
  CloudflareAnalyticsPlugin,
  CloudflareLogsPlugin,
  CompositeObservabilityPlugin,
  type AnalyticsEngineLike,
  type ObservabilityPlugin,
} from "./observability/index.js";
import {
  CfLifecyclePlugin,
  type LifecycleEnv,
} from "./primitives/cf-lifecycle.js";
import { CfResourcesPlugin } from "./primitives/cf-resources.js";
import {
  CfSchedulingPlugin,
  type FiredSchedule,
} from "./primitives/cf-scheduling.js";
import { CfStatePlugin } from "./primitives/cf-state.js";
import { CfTransportPlugin } from "./primitives/cf-transport.js";
import type { RegistryDurableObject } from "./registry-do.js";

export interface AgentEnv extends LifecycleEnv {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  REGISTRY: DurableObjectNamespace<RegistryDurableObject>;
  /**
   * Optional Analytics Engine binding. If present, metrics route
   * to it; if absent, the metric plugin is a no-op. Adopters
   * configure in `wrangler.toml`:
   *
   *     [[analytics_engine_datasets]]
   *     binding = "ANALYTICS"
   *     dataset = "meridian_metrics"
   */
  ANALYTICS?: AnalyticsEngineLike;
}

export class AgentDurableObject extends DurableObject<AgentEnv> {
  private readonly lifecycle: CfLifecyclePlugin;
  private readonly state: CfStatePlugin;
  private readonly scheduling: CfSchedulingPlugin;
  private readonly transport: CfTransportPlugin;
  private readonly resources: CfResourcesPlugin;
  private readonly obs: ObservabilityPlugin;

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env);
    this.lifecycle = new CfLifecyclePlugin(ctx, env);
    this.state = new CfStatePlugin(ctx);
    this.scheduling = new CfSchedulingPlugin(
      ctx,
      async () => (await this.lifecycle.requireMeta()).id,
    );
    this.transport = new CfTransportPlugin(
      ctx,
      env,
      async () => (await this.lifecycle.requireMeta()).id,
      async () => (await this.lifecycle.requireMeta()).domain,
      // Inbound message hook: if the adopter's AgentSpec has an
      // `onMessage` defined, fire it with a context bound to this DO.
      async (msg) => this.invokeOnMessage(msg),
    );
    this.resources = new CfResourcesPlugin(ctx, {
      // Adopter-supplied LimitEventHandler throws shouldn't vanish
      // into a console.warn — route them through the same
      // observability surface as the other hook errors so adopters
      // see them alongside `onSpawn` / `onMessage` failures.
      onHandlerError: async (err) => {
        if (!(await this.lifecycle.exists())) return;
        const handle = await this.lifecycle.get();
        this.emitHookError("onLimitEvent", handle, err);
      },
    });
    this.obs = new CompositeObservabilityPlugin([
      new CloudflareLogsPlugin(),
      new CloudflareAnalyticsPlugin(env.ANALYTICS),
    ]);
  }

  /**
   * DO alarm hook — workerd calls this when the stored alarm fires.
   * Delegates to the scheduling plugin (which persists the fired log
   * and reprograms the next alarm), then fires the adopter's
   * `onSchedule` hook per newly-fired entry so reactive hook
   * adopters don't need to poll `drainFiredSchedules`.
   */
  async alarm(): Promise<void> {
    await this.scheduling.onAlarm();
    await this.invokeOnScheduleForFires();
  }

  // ── Lifecycle ────────────────────────────────────────────

  async spawn(config: SpawnConfig): Promise<AgentHandle> {
    const handle = await this.lifecycle.spawn(config);
    // Fire the adopter's onSpawn hook if defined. Errors don't fail
    // the spawn (the DO is already persisted); they're surfaced
    // via `meridian.hook.errors` metric + structured error log.
    const spec = getAgentSpec(handle.id);
    if (spec?.onSpawn) {
      try {
        await spec.onSpawn(this.contextFor(handle));
      } catch (err) {
        this.emitHookError("onSpawn", handle, err as Error);
      }
    }
    return handle;
  }

  async suspend(): Promise<void> {
    return this.lifecycle.suspend();
  }

  async resume(): Promise<void> {
    return this.lifecycle.resume();
  }

  async terminate(): Promise<void> {
    // Fire the adopter's onTerminate hook BEFORE wiping so they
    // still have access to state.load / transport / etc. If the
    // hook throws, we emit via the hook-error surface and proceed
    // with termination anyway — a stuck hook should not prevent
    // deletion.
    const exists = await this.lifecycle.exists();
    if (exists) {
      const handle = await this.lifecycle.get();
      const spec = getAgentSpec(handle.id);
      if (spec?.onTerminate) {
        try {
          await spec.onTerminate(this.contextFor(handle));
        } catch (err) {
          this.emitHookError("onTerminate", handle, err as Error);
        }
      }
    }
    return this.lifecycle.terminate();
  }

  async get(): Promise<AgentHandle> {
    return this.lifecycle.get();
  }

  async exists(): Promise<boolean> {
    return this.lifecycle.exists();
  }

  async snapshotState(): Promise<never> {
    return this.lifecycle.snapshotState();
  }

  // ── State ────────────────────────────────────────────────

  async save(key: string, value: unknown): Promise<void> {
    return this.state.save(key, value);
  }

  async load<T = unknown>(key: string): Promise<T | undefined> {
    return this.state.load<T>(key);
  }

  async delete(key: string): Promise<void> {
    return this.state.delete(key);
  }

  async list(opts?: ListOptions): Promise<ListResult> {
    return this.state.list(opts);
  }

  /**
   * Atomic integer increment. Public API — stable within a major
   * version. See JSDoc in M2a review for why generic update(key, fn)
   * is NOT on the RPC surface (structured-clone can't serialize
   * functions across DO boundaries).
   */
  async incrementAtomic(key: string, delta = 1): Promise<number> {
    return this.state.update<number>(key, (c) => (c ?? 0) + delta);
  }

  // ── Scheduling ───────────────────────────────────────────

  async scheduleAt(when: Timestamp, payload?: unknown): Promise<ScheduleId> {
    await this.lifecycle.requireMeta();
    return this.scheduling.scheduleAt(when, payload);
  }

  async scheduleCron(cron: string, payload?: unknown): Promise<ScheduleId> {
    await this.lifecycle.requireMeta();
    return this.scheduling.scheduleCron(cron, payload);
  }

  async cancelSchedule(scheduleId: ScheduleId): Promise<void> {
    await this.lifecycle.requireMeta();
    return this.scheduling.cancel(scheduleId);
  }

  async listSchedules(): Promise<ScheduleInfo[]> {
    await this.lifecycle.requireMeta();
    return this.scheduling.listSchedules();
  }

  async drainFiredSchedules(): Promise<FiredSchedule[]> {
    return this.scheduling.drainFiredSchedules();
  }

  // ── Transport ────────────────────────────────────────────

  async send(toAgentId: AgentId, payload: Uint8Array): Promise<MessageReceipt> {
    await this.lifecycle.requireMeta();
    return this.transport.send(toAgentId, payload);
  }

  async broadcast(
    selector: AgentSelector,
    payload: Uint8Array,
  ): Promise<BroadcastReceipt> {
    await this.lifecycle.requireMeta();
    return this.transport.broadcast(selector, payload);
  }

  /**
   * Receive side of the transport primitive — called by the sending
   * DO's transport plugin via DO RPC. Returns the `IncomingMessage`
   * so the sender can build a `MessageReceipt` with the recipient's
   * assigned sequence number and timestamp.
   */
  async deliver(
    fromAgentId: AgentId,
    payload: Uint8Array,
  ): Promise<IncomingMessage> {
    return this.transport.deliver(fromAgentId, payload);
  }

  /** Snapshot the inbox (does NOT clear). */
  async receiveAll(): Promise<IncomingMessage[]> {
    return this.transport.receiveAll();
  }

  /** Pull-and-clear the inbox. Stable public API. */
  async drainInbox(): Promise<IncomingMessage[]> {
    return this.transport.drainAll();
  }

  // ── Resources (RPC surface) ──────────────────────────────

  async setLimits(limits: ResourceLimits): Promise<void> {
    await this.lifecycle.requireMeta();
    return this.resources.setLimits(limits);
  }

  async getLimits(): Promise<ResourceLimits> {
    await this.lifecycle.requireMeta();
    return this.resources.getLimits();
  }

  async getUsage(): Promise<ResourceUsage> {
    await this.lifecycle.requireMeta();
    return this.resources.getUsage();
  }

  async reportTokens(
    n: number,
    attribution?: { workItemId?: string },
  ): Promise<void> {
    await this.lifecycle.requireMeta();
    return this.resources.reportTokens(n, attribution);
  }

  async reportCost(
    usd: number,
    attribution?: { workItemId?: string },
  ): Promise<void> {
    await this.lifecycle.requireMeta();
    return this.resources.reportCost(usd, attribution);
  }

  /**
   * Per-workItemId usage breakdown — the RUNTIME-SPEC §4.5
   * attribution surface. Returns `[]` when no attributed reports
   * have been recorded. Stable public API.
   */
  async getUsageByWorkItem(
    workItemId?: string,
  ): Promise<Array<{ workItemId: string; tokens: number; costUsd: number }>> {
    await this.lifecycle.requireMeta();
    return this.resources.getUsageByWorkItem(workItemId);
  }

  // ── @experimental — permissions throw UNAVAILABLE ────────

  async setPermissions(): Promise<never> {
    throw meridianError("MRD-CF-EX-004");
  }

  async getPermissions(): Promise<never> {
    throw meridianError("MRD-CF-EX-005");
  }

  // ── Internal: hook wiring ────────────────────────────────

  private async invokeOnMessage(msg: IncomingMessage): Promise<void> {
    const handle = await this.lifecycle.get();
    const spec = getAgentSpec(handle.id);
    if (!spec?.onMessage) return;
    try {
      await spec.onMessage(this.contextFor(handle), msg);
    } catch (err) {
      this.emitHookError("onMessage", handle, err as Error);
    }
  }

  /**
   * After `scheduling.onAlarm()` appends fired entries to the log,
   * fire the adopter's `onSchedule` hook once per entry using a
   * peek → invoke → ack loop (RUNTIME-SPEC §4.3 at-least-once).
   * If the DO crashes between peek and ack, the fire stays in the
   * log and the next alarm retries it. If the hook throws, we
   * still ack — adopter code errors count as "delivered"; only
   * a DO crash mid-hook causes redelivery.
   *
   * Adopters that want a batch / polling model keep using
   * `drainFiredSchedules()` and omit `onSchedule`.
   */
  private async invokeOnScheduleForFires(): Promise<void> {
    if (!(await this.lifecycle.exists())) return;
    const handle = await this.lifecycle.get();
    const spec = getAgentSpec(handle.id);
    if (!spec?.onSchedule) return;

    while (true) {
      const fire = await this.scheduling.peekNextFire();
      if (!fire) return;
      try {
        await spec.onSchedule(this.contextFor(handle), fire);
      } catch (err) {
        this.emitHookError("onSchedule", handle, err as Error, {
          fireId: fire.id,
        });
      }
      // Ack AFTER the hook completes (success OR caught throw).
      // If the DO crashed mid-hook before reaching this line, the
      // fire stays in the log for next alarm's replay.
      await this.scheduling.ackFire(fire.id);
    }
  }

  /**
   * Emit a `meridian.hook.errors` metric + structured error log
   * whenever an adopter hook throws. The log carries
   * ErrorFeedback-shaped fields so observability backends that
   * forward to a FeedbackSignal channel see spec-compliant data.
   *
   * Both emissions are try/caught per RUNTIME-SPEC §4.6
   * (observability emission is non-blocking; a broken obs sink
   * must not cascade into the DO's RPC handler).
   */
  private emitHookError(
    hookName:
      | "onSpawn"
      | "onMessage"
      | "onSchedule"
      | "onTerminate"
      | "onLimitEvent",
    handle: { id: AgentId; domain: string },
    err: Error,
    extraFields?: Record<string, unknown>,
  ): void {
    const errorCode = (err as { code?: string }).code;
    const timestamp = Date.now() as Timestamp;
    try {
      this.obs.metric("meridian.hook.errors", 1, {
        hook: hookName,
        agentId: handle.id,
        domain: handle.domain,
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // obs.metric should never throw per spec; swallow for safety.
    }
    try {
      this.obs.log({
        level: "error",
        message: `[agent ${handle.id}] ${hookName} hook threw: ${err.message}`,
        agentId: handle.id,
        domain: handle.domain,
        timestamp,
        fields: {
          // ErrorFeedback-shaped payload — severity `medium` and
          // `recovered: true` because the hook throw does not halt
          // the lifecycle step that triggered it. Adopters who want
          // stricter semantics can re-raise from their own handler.
          tier: "required",
          type: "error",
          category: `hook_error:${hookName}`,
          severity: "medium",
          frequency: "first",
          blastRadius: "internal",
          recovered: true,
          errorCode,
          errorMessage: err.message,
          ...extraFields,
        },
      });
    } catch {
      // ditto.
    }
  }

  /**
   * Build the context object passed to adopter hooks. Methods are
   * thin wrappers over the plugin instances — adopter hooks run
   * inside this DO's isolate, so the `update(key, fn)` path works
   * (no structured-clone boundary for the updater function).
   */
  private contextFor(handle: AgentHandle): AgentContext {
    const agentObs: ObservabilityPlugin = {
      log: (entry) =>
        this.obs.log({
          ...entry,
          agentId: entry.agentId ?? handle.id,
          domain: entry.domain ?? handle.domain,
        }),
      metric: (name, value, tags) =>
        this.obs.metric(name, value, {
          agentId: handle.id,
          domain: handle.domain,
          ...tags,
        }),
      startSpan: (name, parentSpanId) => this.obs.startSpan(name, parentSpanId),
    };

    return {
      id: handle.id,
      domain: handle.domain,
      state: {
        save: (k, v) => this.state.save(k, v),
        load: (k) => this.state.load(k),
        delete: (k) => this.state.delete(k),
        list: (opts) => this.state.list(opts),
        update: (k, fn) => this.state.update(k, fn),
      },
      transport: {
        send: (to, payload) => this.transport.send(to, payload),
        broadcast: (sel, payload) => this.transport.broadcast(sel, payload),
      },
      schedule: {
        at: (when, payload) => this.scheduling.scheduleAt(when, payload),
        cron: (cron, payload) => this.scheduling.scheduleCron(cron, payload),
        cancel: (id) => this.scheduling.cancel(id),
      },
      resources: {
        setLimits: (l) => this.resources.setLimits(l),
        getLimits: () => this.resources.getLimits(),
        getUsage: () => this.resources.getUsage(),
        onLimitEvent: (h) => this.resources.onLimitEvent(h),
        reportTokens: (n, attr) => this.resources.reportTokens(n, attr),
        reportCost: (u, attr) => this.resources.reportCost(u, attr),
        getUsageByWorkItem: (wid) => this.resources.getUsageByWorkItem(wid),
        beginOperation: () => this.resources.beginOperation(),
      },
      obs: agentObs,
    };
  }
}
