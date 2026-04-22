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
  ScheduleId,
  ScheduleInfo,
  SpawnConfig,
  Timestamp,
} from "@loom-loyalty/meridian-types";

import { getAgentSpec, type AgentContext } from "./define-agent.js";
import {
  CfLifecyclePlugin,
  type LifecycleEnv,
} from "./primitives/cf-lifecycle.js";
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
}

export class AgentDurableObject extends DurableObject<AgentEnv> {
  private readonly lifecycle: CfLifecyclePlugin;
  private readonly state: CfStatePlugin;
  private readonly scheduling: CfSchedulingPlugin;
  private readonly transport: CfTransportPlugin;

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
  }

  /**
   * DO alarm hook — workerd calls this when the stored alarm fires.
   * Delegates to the scheduling plugin, which walks every due
   * schedule, fires the ones that are up, advances cron schedules,
   * and reprograms the alarm.
   */
  async alarm(): Promise<void> {
    await this.scheduling.onAlarm();
  }

  // ── Lifecycle ────────────────────────────────────────────

  async spawn(config: SpawnConfig): Promise<AgentHandle> {
    const handle = await this.lifecycle.spawn(config);
    // Fire the adopter's onSpawn hook if defined. Errors don't fail
    // the spawn (the DO is already persisted); they're logged.
    const spec = getAgentSpec(handle.id);
    if (spec?.onSpawn) {
      try {
        await spec.onSpawn(this.contextFor(handle));
      } catch (err) {
        console.warn(
          `[agent ${handle.id}] onSpawn hook threw: ${(err as Error).message}`,
        );
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
    // hook throws, we log and proceed with termination anyway —
    // a stuck hook should not prevent deletion.
    const exists = await this.lifecycle.exists();
    if (exists) {
      const handle = await this.lifecycle.get();
      const spec = getAgentSpec(handle.id);
      if (spec?.onTerminate) {
        try {
          await spec.onTerminate(this.contextFor(handle));
        } catch (err) {
          console.warn(
            `[agent ${handle.id}] onTerminate hook threw: ${(err as Error).message}`,
          );
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

  // ── Internal: onMessage hook wiring ──────────────────────

  private async invokeOnMessage(msg: IncomingMessage): Promise<void> {
    const handle = await this.lifecycle.get();
    const spec = getAgentSpec(handle.id);
    if (!spec?.onMessage) return;
    await spec.onMessage(this.contextFor(handle), msg);
  }

  /**
   * Build the context object passed to adopter hooks. Methods are
   * thin wrappers over the plugin instances — adopter hooks run
   * inside this DO's isolate, so the `update(key, fn)` path works
   * (no structured-clone boundary for the updater function).
   */
  private contextFor(handle: AgentHandle): AgentContext {
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
    };
  }
}
