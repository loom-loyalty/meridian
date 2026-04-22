/**
 * Internal plugin seams for the CF adapter's primitive implementations.
 *
 * These interfaces are NOT exported from the package. They exist to
 * separate concerns inside `AgentDurableObject` so each primitive's
 * implementation lives in its own file with a clear contract. Per the
 * eng-review decision (2026-04-21), public plugin interfaces are
 * published in v0.2 once a real external plugin exists; v0.1 only
 * exports the {@link ObservabilityPlugin} interface (that one has clear
 * demand signal from adopters bringing their own observability stack).
 *
 * Each plugin is scoped to ONE {@link AgentDurableObject} instance, so
 * the plugin method signatures drop the `agentId` parameter that the
 * public `@loom-loyalty/meridian-types` interfaces carry. The DO's RPC
 * surface is what bridges the two worlds.
 */

import type {
  AgentHandle,
  AgentId,
  AgentSelector,
  BroadcastReceipt,
  IncomingMessage,
  LimitEventHandler,
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

/**
 * Agent lifecycle for a single AgentDurableObject instance.
 *
 * Matches the public {@link AgentLifecycle} shape from `meridian-types`
 * minus the `agentId` parameter (each plugin is already bound to one
 * DO). `snapshotState` throws `MRD-CF-EX-001` in v0.1.
 */
export interface LifecyclePlugin {
  spawn(config: SpawnConfig): Promise<AgentHandle>;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  terminate(): Promise<void>;
  get(): Promise<AgentHandle>;
  exists(): Promise<boolean>;
  /** @experimental throws MRD-CF-EX-001 in v0.1 */
  snapshotState(): Promise<never>;
}

/**
 * Per-agent state persistence.
 *
 * Matches the public {@link StatePersistence} shape minus the `agentId`
 * parameter. Validates 1024 B key + 1 MB value limits per
 * RUNTIME-SPEC §4.2 and rejects reserved key prefixes.
 */
export interface StatePlugin {
  save(key: string, value: unknown): Promise<void>;
  load<T = unknown>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  list(opts?: ListOptions): Promise<ListResult>;
  update<T>(key: string, updater: (current: T | undefined) => T): Promise<T>;
}

/**
 * Scheduled invocations for a single agent.
 *
 * Uses DO alarms under the hood: many schedules collapse onto one
 * alarm set to the earliest pending fire time, and the plugin's alarm
 * handler fires everything due + reschedules. Cron is parsed via
 * `croner` (eng-review decision, 2026-04-21). `scheduleAt` validates
 * the 1s/365d bounds from RUNTIME-SPEC §4.3; cron coalescing on
 * resume handles the "DO was offline for N cron ticks, fire once"
 * case.
 */
export interface SchedulingPlugin {
  scheduleAt(when: Timestamp, payload?: unknown): Promise<ScheduleId>;
  scheduleCron(cron: string, payload?: unknown): Promise<ScheduleId>;
  cancel(scheduleId: ScheduleId): Promise<void>;
  listSchedules(): Promise<ScheduleInfo[]>;
  /**
   * Called by the hosting DO's `alarm()` handler. Fires every
   * schedule whose `nextFireAt` has elapsed and reprograms the
   * alarm for the next due schedule. Cron schedules get their
   * `nextFireAt` advanced; once schedules are removed post-fire.
   */
  onAlarm(): Promise<void>;
}

/**
 * Agent-to-agent transport for a single DO instance.
 *
 * Mailbox layout per the eng-review decision (2026-04-21): one
 * AgentDurableObject per recipient, with incoming messages
 * partitioned by sender via `__mail::${fromAgentId}` keys. Per-sender
 * monotonic sequence numbers provide the RUNTIME-SPEC §4.4
 * "at-least-once + in-order per sender/recipient pair" guarantee
 * without forcing one DO per (sender, recipient) pair.
 *
 * `onDeliver` is the hook the DO calls right after a message lands
 * in the inbox. In M2c that hook invokes the user's AgentSpec
 * `onMessage` if defined; in M2b the same slot is unused (inbox
 * polling via `receive()` from drainFiredMessages-style companion).
 */
export interface TransportPlugin {
  send(toAgentId: AgentId, payload: Uint8Array): Promise<MessageReceipt>;
  broadcast(
    selector: AgentSelector,
    payload: Uint8Array,
  ): Promise<BroadcastReceipt>;
  /** Receive side — appends to the sender-partitioned inbox. */
  deliver(fromAgentId: AgentId, payload: Uint8Array): Promise<IncomingMessage>;
  /** Pull every queued message across all senders, oldest first. */
  receiveAll(): Promise<IncomingMessage[]>;
  /** Empty the mailbox across all senders. */
  drainAll(): Promise<IncomingMessage[]>;
}

/**
 * Resource accounting + enforcement for a single agent.
 *
 * What we can actually measure in workerd user-space is tokens + USD
 * cost + concurrent-operation count. Memory and CPU are managed by
 * the CF platform itself (hard-killed on limit exceed), so those
 * fields in {@link ResourceUsage} are best-effort approximations.
 *
 * Adopter code reports tokens/cost via `reportTokens` /
 * `reportCost`; enforcement happens BEFORE the counter increments so
 * a single over-limit call fails without partial accounting.
 * `getUsage()` is sub-1-second latency (DO-storage reads, not
 * Analytics Engine round-trips) per RUNTIME-SPEC §4.5.
 *
 * `setLimits` in-flight semantics: already-started operations
 * complete under their OWN limits snapshot; subsequent operations
 * see the new limits. The plugin doesn't try to mid-operation
 * interrupt — that's not reachable without a cooperative cancel
 * mechanism the spec doesn't yet define.
 */
export interface ResourcesPlugin {
  setLimits(limits: ResourceLimits): Promise<void>;
  getLimits(): Promise<ResourceLimits>;
  getUsage(): Promise<ResourceUsage>;
  onLimitEvent(handler: LimitEventHandler): Promise<void>;

  /** Adopter reports token consumption. Throws on limit breach. */
  reportTokens(n: number, attribution?: { workItemId?: string }): Promise<void>;
  /** Adopter reports USD cost. Throws on limit breach. */
  reportCost(usd: number, attribution?: { workItemId?: string }): Promise<void>;

  /**
   * Begin an operation — increments activeOperations after enforcing
   * the concurrency cap. Returns a dispose token; the caller MUST
   * call the returned `endOperation()` when done so the counter
   * decrements (use a try/finally in adopter hook code).
   */
  beginOperation(): Promise<() => Promise<void>>;
}

/**
 * Observability for emitting structured logs, metrics, and spans.
 *
 * Public plugin API (exported from the package per the eng-review
 * decision — the ONE plugin with clear external demand signal).
 * Adopters can swap `CloudflareAnalyticsPlugin` / `CloudflareLogsPlugin`
 * for an OTEL/Datadog/Honeycomb adapter when they ship.
 *
 * Emission is non-blocking per RUNTIME-SPEC §4.6. Automatic
 * dimensions (`agentId`, `domain`, `workItemId`) are merged into
 * every emit by the hosting DO.
 */
export interface ObservabilityPlugin {
  log(entry: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
    agentId?: string;
    domain?: string;
    workItemId?: string;
    timestamp: Timestamp;
    fields?: Record<string, unknown>;
  }): void;
  metric(name: string, value: number, tags?: Record<string, string>): void;
  startSpan(
    name: string,
    parentSpanId?: string,
  ): {
    spanId: string;
    traceId: string;
    setAttribute(key: string, value: string | number | boolean): void;
    addEvent(name: string, attributes?: Record<string, unknown>): void;
    end(): void;
  };
}
