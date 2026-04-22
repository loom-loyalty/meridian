/**
 * Runtime conformance contract.
 *
 * A `Runtime` is an implementation under test. Scenarios call into it
 * through this abstraction so the same suite can run against the
 * Miniflare-backed Cloudflare runtime, an in-memory `createTestRuntime()`
 * for adopter unit tests, and (eventually) third-party runtimes on other
 * platforms.
 *
 * Scenarios allocate a unique agent id per run via
 * {@link ScenarioContext.uniqueId} and rely on {@link Runtime.agent}
 * to return a stub bound to the named agent. Each stub is roughly the
 * RPC surface of {@link AgentDurableObject}, but narrowed to just
 * what scenarios need (methods added here as the suite grows).
 *
 * Adapters MUST:
 *   • Return a fresh world state per scenario run (no shared state
 *     across scenarios). Tests that need shared state use explicit
 *     cross-agent messaging.
 *   • Advertise `kind: "in-memory" | "miniflare" | "real-cf"` so
 *     scenarios can skip when they depend on a physical feature the
 *     adapter cannot emulate (durability across process restarts,
 *     hibernation-replay, true DO alarm coalescing across offline
 *     windows, etc.).
 */

import type {
  AgentHandle,
  AgentId,
  AgentSelector,
  BroadcastReceipt,
  DomainId,
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

/**
 * The minimal per-agent RPC surface scenarios exercise. Mirrors
 * `AgentDurableObject`'s public methods, scoped to a bound agent id.
 */
export interface AgentRef {
  spawn(config: SpawnConfig): Promise<AgentHandle>;
  terminate(): Promise<void>;
  exists(): Promise<boolean>;
  get(): Promise<AgentHandle>;

  save(key: string, value: unknown): Promise<void>;
  load<T = unknown>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  list(opts?: ListOptions): Promise<ListResult>;
  incrementAtomic(key: string, delta?: number): Promise<number>;

  scheduleAt(when: Timestamp, payload?: unknown): Promise<ScheduleId>;
  scheduleCron(cron: string, payload?: unknown): Promise<ScheduleId>;
  cancelSchedule(id: ScheduleId): Promise<void>;
  listSchedules(): Promise<ScheduleInfo[]>;

  send(toAgentId: AgentId, payload: Uint8Array): Promise<MessageReceipt>;
  broadcast(
    selector: AgentSelector,
    payload: Uint8Array,
  ): Promise<BroadcastReceipt>;
  receiveAll(): Promise<IncomingMessage[]>;
  drainInbox(): Promise<IncomingMessage[]>;

  setLimits(limits: ResourceLimits): Promise<void>;
  getLimits(): Promise<ResourceLimits>;
  getUsage(): Promise<ResourceUsage>;
  reportTokens(n: number, attribution?: { workItemId?: string }): Promise<void>;
  reportCost(usd: number, attribution?: { workItemId?: string }): Promise<void>;
  getUsageByWorkItem(
    workItemId?: string,
  ): Promise<Array<{ workItemId: string; tokens: number; costUsd: number }>>;

  /** @experimental — MUST throw with an UNAVAILABLE category error. */
  snapshotState(): Promise<never>;
  /** @experimental — MUST throw with an UNAVAILABLE category error. */
  setPermissions(): Promise<never>;
  /** @experimental — MUST throw with an UNAVAILABLE category error. */
  getPermissions(): Promise<never>;
}

/**
 * The runtime implementation under test. Exposes one factory for
 * getting per-agent refs, plus metadata scenarios use to skip-gate.
 */
export interface Runtime {
  readonly kind: "in-memory" | "miniflare" | "real-cf";
  agent(id: AgentId): AgentRef;
  /**
   * Trigger the agent's DO alarm handler synchronously. Used by
   * scheduling scenarios that don't want to sleep real time.
   * Adapters that don't support this (in-memory runs its own
   * synchronous scheduler) can no-op.
   */
  runAlarm(id: AgentId): Promise<void>;
  /**
   * Optional hook for scenarios to wait out a short real-time delay
   * (e.g. scheduleAt 1.1s). Adapters may substitute fake timers.
   */
  sleep(ms: number): Promise<void>;
}

export interface ConformanceScenario {
  name: string;
  description: string;
  /**
   * Adapter kinds this scenario is applicable under. Scenarios that
   * depend on genuine DO durability / hibernation declare
   * `["real-cf"]` and are skipped by the Miniflare / in-memory
   * adapters.
   */
  appliesTo: ReadonlyArray<Runtime["kind"]>;
  run(runtime: Runtime, ctx: ScenarioContext): Promise<void>;
}

export interface ScenarioContext {
  /** Return a fresh unique identifier for an agent / domain within the scenario. */
  uniqueId(prefix: string): string;
  /** Fail the scenario with a specific message. */
  fail(reason: string): never;
}

export interface ConformanceResult {
  scenario: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
  durationMs: number;
}

export interface RunConformanceOptions {
  /** Skip a scenario by name (escape hatch; adapters should prefer `appliesTo`). */
  skip?: ReadonlyArray<string>;
  /** Only run scenarios matching these names (exact match). */
  only?: ReadonlyArray<string>;
}

/**
 * A helper type for building {@link AgentHandle}-returning fixtures
 * inside the in-memory runtime. Not part of the conformance API.
 */
export interface AgentFixture {
  id: AgentId;
  domain: DomainId;
}
