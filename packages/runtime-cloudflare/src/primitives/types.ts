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
  ListOptions,
  ListResult,
  SpawnConfig,
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
