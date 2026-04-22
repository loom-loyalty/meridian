/**
 * Agent authoring helper — `defineAgent()`.
 *
 * Single-function authoring API per the DX review decision
 * (2026-04-21). Adopters declare their agent once at module-load
 * time; the `AgentDurableObject` looks up the spec by agent id on
 * first access and invokes the registered hooks.
 *
 * Hook surface (M2c):
 *   onSpawn    — fires after spawn persists; adopter seeds baselines
 *   onMessage  — fires when a message lands in the mailbox
 *   onTerminate — fires before terminate() wipes state
 *
 * Hooks run INSIDE the DO isolate with access to a typed context
 * (see {@link AgentContext}) that wraps the state/transport/scheduling
 * primitives. Because the context uses the plugin methods directly,
 * adopter code can call the generic `update(key, fn)` (which crosses
 * no RPC boundary here; the function runs in-process).
 *
 * onSchedule lands in M2d alongside the observability hook.
 */

import type {
  AgentId,
  AgentSelector,
  BroadcastReceipt,
  DomainId,
  IncomingMessage,
  ListOptions,
  ListResult,
  MessageReceipt,
  ScheduleId,
  Timestamp,
} from "@loom-loyalty/meridian-types";

/**
 * The context passed to every `AgentSpec` hook. Provides scoped
 * state / transport / scheduling surfaces bound to the hosting DO.
 * M2d adds observability + resources to this context.
 */
export interface AgentContext {
  readonly id: AgentId;
  readonly domain: DomainId;

  readonly state: {
    save(key: string, value: unknown): Promise<void>;
    load<T = unknown>(key: string): Promise<T | undefined>;
    delete(key: string): Promise<void>;
    list(opts?: ListOptions): Promise<ListResult>;
    update<T>(key: string, updater: (current: T | undefined) => T): Promise<T>;
  };

  readonly transport: {
    send(toAgentId: AgentId, payload: Uint8Array): Promise<MessageReceipt>;
    broadcast(
      selector: AgentSelector,
      payload: Uint8Array,
    ): Promise<BroadcastReceipt>;
  };

  readonly schedule: {
    at(when: Timestamp, payload?: unknown): Promise<ScheduleId>;
    cron(cron: string, payload?: unknown): Promise<ScheduleId>;
    cancel(scheduleId: ScheduleId): Promise<void>;
  };
}

export interface AgentSpec {
  id: AgentId;
  domain: DomainId;

  /**
   * Fires once after `spawn()` persists meta (and post-identity-guard).
   * Use to seed baselines, register defaults, fire a first heartbeat,
   * etc. Errors in `onSpawn` are logged but do NOT fail the spawn —
   * the DO is still spawned; adopters should observe their own
   * signal surface for startup diagnostics.
   */
  onSpawn?(ctx: AgentContext): Promise<void>;

  /**
   * Fires after a message lands in this agent's inbox. Runs in the
   * same request as the sender's `send()` / `broadcast()` fan-out,
   * after the storage write (so if the hook throws, the message is
   * still persisted and can be replayed via `drainFiredMessages`).
   * Hook errors don't bubble to the sender.
   */
  onMessage?(ctx: AgentContext, msg: IncomingMessage): Promise<void>;

  /**
   * Fires before `terminate()`'s `deleteAll()`. Last chance to emit
   * a draining signal or flush state to an external store. Errors
   * are logged but do NOT stop termination.
   */
  onTerminate?(ctx: AgentContext): Promise<void>;
}

const AGENT_REGISTRY = new Map<AgentId, AgentSpec>();

export function defineAgent(spec: AgentSpec): AgentSpec {
  if (!spec.id) {
    throw new Error("defineAgent: `id` is required");
  }
  if (!spec.domain) {
    throw new Error("defineAgent: `domain` is required");
  }
  AGENT_REGISTRY.set(spec.id, spec);
  return spec;
}

export function getAgentSpec(id: AgentId): AgentSpec | undefined {
  return AGENT_REGISTRY.get(id);
}

export function listAgentSpecs(): AgentSpec[] {
  return Array.from(AGENT_REGISTRY.values());
}
