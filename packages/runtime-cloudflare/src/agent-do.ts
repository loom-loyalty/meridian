/**
 * AgentDurableObject — composed plugin surface.
 *
 * One DO instance per spawned agent (`env.AGENT.idFromName(agentId)`).
 * This class is the RPC boundary Miniflare and real CF both speak; it
 * delegates every method to the matching internal plugin
 * (`CfLifecyclePlugin`, `CfStatePlugin`, etc). Plugins live in
 * `./primitives/`; they are NOT exported from the package in v0.1 per
 * the eng-review reframing (internal seams for legibility, public
 * plugin API in v0.2 once an external plugin implementation exists).
 *
 * Primitives implemented in M2a:
 *   • Lifecycle — spawn / suspend / resume / terminate / get / exists
 *                 (+ snapshotState @experimental → UNAVAILABLE)
 *   • State     — save / load / delete / list / update
 *                 (+ 1 MB value / 1024 B key / reserved-prefix validation)
 *
 * Transport primitives still inherit the M1 inbox-append model;
 * M2c refactors them to the sender-partitioned-per-recipient mailbox
 * and wires the user's `onMessage` hook. Scheduling / resources /
 * observability land in M2b / M2d.
 */

import { DurableObject } from "cloudflare:workers";
import type {
  AgentHandle,
  AgentId,
  ListOptions,
  ListResult,
  ScheduleId,
  ScheduleInfo,
  SpawnConfig,
  Timestamp,
} from "@loom-loyalty/meridian-types";

import {
  CfLifecyclePlugin,
  type LifecycleEnv,
} from "./primitives/cf-lifecycle.js";
import {
  CfSchedulingPlugin,
  type FiredSchedule,
} from "./primitives/cf-scheduling.js";
import { CfStatePlugin } from "./primitives/cf-state.js";

import type { RegistryDurableObject } from "./registry-do.js";

export interface AgentEnv extends LifecycleEnv {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  REGISTRY: DurableObjectNamespace<RegistryDurableObject>;
}

export interface InboxEntry {
  fromAgentId: AgentId;
  payload: Uint8Array;
  receivedAt: Timestamp;
}

const INBOX_KEY = "__inbox__";

export class AgentDurableObject extends DurableObject<AgentEnv> {
  private readonly lifecycle: CfLifecyclePlugin;
  private readonly state: CfStatePlugin;
  private readonly scheduling: CfSchedulingPlugin;

  constructor(ctx: DurableObjectState, env: AgentEnv) {
    super(ctx, env);
    this.lifecycle = new CfLifecyclePlugin(ctx, env);
    this.state = new CfStatePlugin(ctx);
    this.scheduling = new CfSchedulingPlugin(
      ctx,
      // Resolve agent id from the lifecycle plugin at call time so the
      // scheduling plugin doesn't peek into lifecycle's storage layout.
      async () => (await this.lifecycle.requireMeta()).id,
    );
  }

  /**
   * DO alarm hook — workerd calls this when the stored alarm fires.
   * The scheduling plugin walks every registered schedule, fires the
   * due ones (including cron coalescing for ticks missed during DO
   * downtime), and reprograms the alarm for the next due schedule.
   * Any other future primitive that uses alarms (e.g. delayed
   * at-least-once redelivery in M2c) hooks in here too.
   */
  async alarm(): Promise<void> {
    await this.scheduling.onAlarm();
  }

  // ── Lifecycle ────────────────────────────────────────────

  async spawn(config: SpawnConfig): Promise<AgentHandle> {
    return this.lifecycle.spawn(config);
  }

  async suspend(): Promise<void> {
    return this.lifecycle.suspend();
  }

  async resume(): Promise<void> {
    return this.lifecycle.resume();
  }

  async terminate(): Promise<void> {
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

  // `update()` deliberately does NOT appear on the DO RPC surface:
  // DO RPC uses structured clone, which cannot serialize functions,
  // so an `updater` callback sent from outside the DO would throw
  // `DataCloneError: #<RpcPromise> could not be cloned`. The plugin
  // method (`this.state.update`) still runs fine INSIDE the DO — M2c
  // wires it into `defineAgent`'s context helpers so adopter code
  // called via the onMessage/onSchedule hooks has full access. For
  // external atomic updates from a Worker fetch handler, the idiom
  // is to call a specific RPC method (see `incrementAtomic` below)
  // that wraps the update pattern internally.

  /**
   * Atomic integer increment. Public API — stable within a major
   * version.
   *
   * This is the canonical pattern for atomic state updates from
   * OUTSIDE the DO (e.g. a Worker fetch handler). The underlying
   * state plugin's `update(key, fn)` primitive takes a function
   * which can't cross the DO RPC boundary via structured clone, so
   * data-shaped RPCs like this one wrap the common cases. Adopter
   * code running INSIDE the DO (via defineAgent hooks, arriving in
   * M2c) has full access to the generic update() through the
   * authoring context.
   *
   * Pattern works for any value that supports "seed if undefined,
   * add delta" semantics. For richer transformers, adopters define
   * their own DO subclass methods following the same pattern.
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

  /**
   * Pull-and-clear the fired-schedule log. Public API — stable
   * within a major version.
   *
   * Each call returns every schedule fire that happened since the
   * previous drain, then empties the log. M2c adds a direct
   * `onSchedule` user hook (invoked inside the DO at fire time) for
   * reactive handling; `drainFiredSchedules()` remains as the
   * batch-poll companion — useful for inspection, replay, and
   * adopters who prefer explicit pull semantics.
   */
  async drainFiredSchedules(): Promise<FiredSchedule[]> {
    return this.scheduling.drainFiredSchedules();
  }

  // ── Transport (M1 inbox model; M2c replaces) ─────────────

  async sendTo(targetAgentId: AgentId, payload: Uint8Array): Promise<void> {
    const meta = await this.lifecycle.requireMeta();
    const targetStub = this.env.AGENT.get(
      this.env.AGENT.idFromName(targetAgentId),
    ) as unknown as DurableObjectStub<AgentDurableObject>;
    await targetStub.deliver(meta.id, payload);
  }

  async deliver(fromAgentId: AgentId, payload: Uint8Array): Promise<void> {
    const inbox = (await this.ctx.storage.get<InboxEntry[]>(INBOX_KEY)) ?? [];
    inbox.push({ fromAgentId, payload, receivedAt: Date.now() });
    await this.ctx.storage.put(INBOX_KEY, inbox);
  }

  async receive(): Promise<InboxEntry[]> {
    return (await this.ctx.storage.get<InboxEntry[]>(INBOX_KEY)) ?? [];
  }
}
