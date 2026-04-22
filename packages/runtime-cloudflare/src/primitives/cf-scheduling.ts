/**
 * Cloudflare implementation of the {@link SchedulingPlugin} seam.
 *
 * Model: many schedules per agent, one DO alarm. The plugin always
 * sets the alarm to the earliest `nextFireAt` across all pending
 * schedules; when the alarm fires, {@link onAlarm} walks every
 * schedule, fires the ones that are due, advances cron schedules to
 * their next tick, removes once-schedules that already fired, and
 * reprograms the alarm to the new earliest. Adopters access the
 * fired events via {@link drainFiredSchedules} — M2c replaces that
 * polling surface with a direct `onSchedule` hook invocation on the
 * user's AgentSpec.
 *
 * Cron parsing uses `croner` (eng-review decision; zero deps,
 * DST-aware, works in Workers).
 *
 * Coalescing on resume: when the DO has been offline for multiple
 * cron ticks, `onAlarm` only fires the cron ONCE and advances
 * `nextFireAt` to the strictly-future next tick. A fire-event carries
 * a `coalescedTicks` count so consumers can see how many logical
 * invocations were folded into one.
 */

import { Cron } from "croner";

import type {
  ScheduleId,
  ScheduleInfo,
  Timestamp,
} from "@loom-loyalty/meridian-types";

import { meridianError } from "../errors.js";
import type { SchedulingPlugin } from "./types.js";

const SCHEDULES_KEY = "__schedules__";
const FIRED_KEY = "__fired_schedules__";

const MIN_DELAY_MS = 1_000; // 1 second
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1_000; // 365 days

export interface StoredSchedule {
  id: ScheduleId;
  type: "once" | "cron";
  cron?: string;
  payload?: unknown;
  nextFireAt: Timestamp;
  /** For cron: the last tick we actually fired for this schedule. */
  lastFiredAt?: Timestamp;
  createdAt: Timestamp;
}

export interface FiredSchedule {
  id: ScheduleId;
  type: "once" | "cron";
  payload?: unknown;
  firedAt: Timestamp;
  /**
   * 1 for normal fires; > 1 when the DO was offline for multiple
   * cron ticks and we coalesced them into a single invocation.
   */
  coalescedTicks: number;
  /** For cron: the scheduled tick we are satisfying with this fire. */
  scheduledFor: Timestamp;
}

export class CfSchedulingPlugin implements SchedulingPlugin {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly clock: () => Timestamp = Date.now,
  ) {}

  async scheduleAt(when: Timestamp, payload?: unknown): Promise<ScheduleId> {
    const now = this.clock();
    const delay = when - now;
    if (delay < MIN_DELAY_MS) {
      throw meridianError(
        "MRD-CF-SC-001",
        `scheduleAt delay ${delay}ms below 1000ms minimum`,
        { context: { when, now, delayMs: delay } },
      );
    }
    if (delay > MAX_DELAY_MS) {
      throw meridianError(
        "MRD-CF-SC-002",
        `scheduleAt delay ${delay}ms above 365-day maximum`,
        { context: { when, now, delayMs: delay } },
      );
    }

    const schedule: StoredSchedule = {
      id: crypto.randomUUID(),
      type: "once",
      payload,
      nextFireAt: when,
      createdAt: now,
    };

    await this.persist(schedule);
    return schedule.id;
  }

  async scheduleCron(cron: string, payload?: unknown): Promise<ScheduleId> {
    const now = this.clock();
    // Croner throws on invalid patterns; re-wrap with our error code
    // so adopters get a stable `MRD-CF-SC-003` to pattern-match on.
    let job: Cron;
    try {
      job = new Cron(cron);
    } catch (e) {
      throw meridianError(
        "MRD-CF-SC-003",
        `cron pattern "${cron}" rejected: ${(e as Error).message}`,
        { cause: e as Error, context: { cron } },
      );
    }
    const next = job.nextRun(new Date(now));
    if (!next) {
      throw meridianError(
        "MRD-CF-SC-003",
        `cron pattern "${cron}" produced no future run`,
        { context: { cron } },
      );
    }

    const schedule: StoredSchedule = {
      id: crypto.randomUUID(),
      type: "cron",
      cron,
      payload,
      nextFireAt: next.getTime(),
      createdAt: now,
    };

    await this.persist(schedule);
    return schedule.id;
  }

  async cancel(scheduleId: ScheduleId): Promise<void> {
    const schedules = await this.loadSchedules();
    const idx = schedules.findIndex((s) => s.id === scheduleId);
    if (idx === -1) {
      throw meridianError(
        "MRD-CF-SC-004",
        `scheduleId "${scheduleId}" not registered`,
        { context: { scheduleId } },
      );
    }
    schedules.splice(idx, 1);
    await this.ctx.storage.put(SCHEDULES_KEY, schedules);
    await this.reprogramAlarm(schedules);
  }

  async listSchedules(): Promise<ScheduleInfo[]> {
    const schedules = await this.loadSchedules();
    const meta = await this.ctx.storage.get<{ id: string }>("__meta__");
    const agentId = meta?.id ?? "";
    return schedules.map((s) => ({
      id: s.id,
      agentId,
      type: s.type,
      nextFireAt: s.nextFireAt,
      cron: s.cron,
      payload: s.payload,
    }));
  }

  async onAlarm(): Promise<void> {
    const now = this.clock();
    const schedules = await this.loadSchedules();
    const fired = await this.loadFiredLog();

    const remaining: StoredSchedule[] = [];

    for (const s of schedules) {
      if (s.nextFireAt > now) {
        remaining.push(s);
        continue;
      }

      if (s.type === "once") {
        fired.push({
          id: s.id,
          type: "once",
          payload: s.payload,
          firedAt: now,
          coalescedTicks: 1,
          scheduledFor: s.nextFireAt,
        });
        // Once schedules drop off the list after firing.
        continue;
      }

      // Cron: compute how many ticks we missed while the DO was
      // offline, fire once, advance nextFireAt to the strictly-future
      // next tick, keep the schedule on the list.
      const cronJob = new Cron(s.cron!);
      let coalescedTicks = 1;
      let probe = s.nextFireAt;
      // Count past-due ticks: how many times would this cron have
      // fired between `nextFireAt` and `now`?
      for (;;) {
        const next = cronJob.nextRun(new Date(probe));
        if (!next || next.getTime() > now) break;
        coalescedTicks++;
        probe = next.getTime();
      }

      fired.push({
        id: s.id,
        type: "cron",
        payload: s.payload,
        firedAt: now,
        coalescedTicks,
        scheduledFor: s.nextFireAt,
      });

      const nextFire = cronJob.nextRun(new Date(now));
      if (nextFire) {
        remaining.push({
          ...s,
          lastFiredAt: now,
          nextFireAt: nextFire.getTime(),
        });
      }
      // If croner returns null (e.g., a pattern that only fires
      // once and we just consumed that fire), drop the schedule.
    }

    await this.ctx.storage.put(SCHEDULES_KEY, remaining);
    await this.ctx.storage.put(FIRED_KEY, fired);
    await this.reprogramAlarm(remaining);
  }

  // ── Test / M2c-bridging helpers ───────────────────────────

  /**
   * Pull-and-clear the fired schedule log. Test-facing in M2b;
   * M2c replaces this with direct `onSchedule` hook invocation on
   * the user's AgentSpec inside `onAlarm`.
   */
  async drainFiredSchedules(): Promise<FiredSchedule[]> {
    const fired = await this.loadFiredLog();
    await this.ctx.storage.put(FIRED_KEY, []);
    return fired;
  }

  // ── internal ─────────────────────────────────────────────

  private async persist(schedule: StoredSchedule): Promise<void> {
    const schedules = await this.loadSchedules();
    schedules.push(schedule);
    await this.ctx.storage.put(SCHEDULES_KEY, schedules);
    await this.reprogramAlarm(schedules);
  }

  private async loadSchedules(): Promise<StoredSchedule[]> {
    return (await this.ctx.storage.get<StoredSchedule[]>(SCHEDULES_KEY)) ?? [];
  }

  private async loadFiredLog(): Promise<FiredSchedule[]> {
    return (await this.ctx.storage.get<FiredSchedule[]>(FIRED_KEY)) ?? [];
  }

  /**
   * Sets the DO alarm to the earliest `nextFireAt` across the
   * given schedule list. If the list is empty, clears the alarm so
   * the DO can hibernate.
   */
  private async reprogramAlarm(schedules: StoredSchedule[]): Promise<void> {
    let earliest: Timestamp | undefined;
    for (const s of schedules) {
      if (earliest === undefined || s.nextFireAt < earliest) {
        earliest = s.nextFireAt;
      }
    }

    if (earliest === undefined) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(earliest);
  }
}
