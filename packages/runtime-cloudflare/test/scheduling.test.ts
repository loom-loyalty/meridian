/**
 * M2b scheduling primitive tests.
 *
 * Covers:
 *   • scheduleAt basic fire path via `runDurableObjectAlarm` + real clock
 *   • Bound validation (1s minimum, 365d maximum) → MRD-CF-SC-001/002
 *   • Cron pattern validation → MRD-CF-SC-003
 *   • cancel() with unknown id → MRD-CF-SC-004
 *   • listSchedules returns active schedules
 *   • Multi-schedule: several pending, alarm fires all that are due
 *   • Cron coalescing: DO "offline" for multiple ticks, fire once
 *     with `coalescedTicks > 1`
 *
 * Coalescing is the tricky one — we don't wait real time; we seed
 * past-due schedules directly via storage so `onAlarm()` sees them
 * as already overdue. The vitest-pool-workers `runInDurableObject`
 * helper is how we reach into the DO's storage for the test setup.
 */

import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { AgentDurableObject } from "../src/agent-do.js";
import type { StoredSchedule } from "../src/primitives/cf-scheduling.js";

type AgentStub = DurableObjectStub<AgentDurableObject>;

function stub(id: string): AgentStub {
  return env.AGENT.get(env.AGENT.idFromName(id)) as unknown as AgentStub;
}

describe("scheduling primitive", () => {
  it("rejects scheduleAt delays below 1 second with MRD-CF-SC-001", async () => {
    const a = stub("sc-min-bound");
    await a.spawn({ id: "sc-min-bound", domain: "test" });

    await expect(a.scheduleAt(Date.now() + 500)).rejects.toThrow(
      /MRD-CF-SC-001/,
    );

    await a.terminate();
  });

  it("rejects scheduleAt delays above 365 days with MRD-CF-SC-002", async () => {
    const a = stub("sc-max-bound");
    await a.spawn({ id: "sc-max-bound", domain: "test" });

    const farFuture = Date.now() + 366 * 24 * 60 * 60 * 1000;
    await expect(a.scheduleAt(farFuture)).rejects.toThrow(/MRD-CF-SC-002/);

    await a.terminate();
  });

  it("rejects invalid cron patterns with MRD-CF-SC-003", async () => {
    const a = stub("sc-bad-cron");
    await a.spawn({ id: "sc-bad-cron", domain: "test" });

    await expect(a.scheduleCron("not-a-cron")).rejects.toThrow(/MRD-CF-SC-003/);

    await a.terminate();
  });

  it("cancel on unknown scheduleId throws MRD-CF-SC-004", async () => {
    const a = stub("sc-cancel-missing");
    await a.spawn({ id: "sc-cancel-missing", domain: "test" });

    await expect(a.cancelSchedule("does-not-exist")).rejects.toThrow(
      /MRD-CF-SC-004/,
    );

    await a.terminate();
  });

  it("scheduleAt + listSchedules round-trips ScheduleInfo", async () => {
    const a = stub("sc-list");
    await a.spawn({ id: "sc-list", domain: "test" });

    const when = Date.now() + 60_000;
    const id = await a.scheduleAt(when, { tag: "demo" });
    const list = await a.listSchedules();

    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      agentId: "sc-list",
      type: "once",
      nextFireAt: when,
      payload: { tag: "demo" },
    });

    await a.terminate();
  });

  it("cancel removes a pending once-schedule", async () => {
    const a = stub("sc-cancel");
    await a.spawn({ id: "sc-cancel", domain: "test" });

    const id = await a.scheduleAt(Date.now() + 60_000);
    expect((await a.listSchedules()).map((s) => s.id)).toContain(id);

    await a.cancelSchedule(id);
    expect(await a.listSchedules()).toHaveLength(0);

    await a.terminate();
  });

  it("firing a once-schedule appends to the fired log and removes it", async () => {
    const a = stub("sc-fire-once");
    await a.spawn({ id: "sc-fire-once", domain: "test" });

    const when = Date.now() + 1100;
    const id = await a.scheduleAt(when, "payload-1");
    expect(await a.listSchedules()).toHaveLength(1);

    // Wait past the scheduled time, then trigger the alarm.
    await new Promise((r) => setTimeout(r, 1200));
    await runDurableObjectAlarm(a);

    const fired = await a.drainFiredSchedules();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      id,
      type: "once",
      payload: "payload-1",
      coalescedTicks: 1,
      scheduledFor: when,
    });

    // Once-schedule removed from active list.
    expect(await a.listSchedules()).toHaveLength(0);
    // Drain clears the log.
    expect(await a.drainFiredSchedules()).toHaveLength(0);

    await a.terminate();
  });

  it("fires multiple due schedules in the same alarm pass", async () => {
    const a = stub("sc-multi");
    await a.spawn({ id: "sc-multi", domain: "test" });

    const now = Date.now();
    const id1 = await a.scheduleAt(now + 1100, "A");
    const id2 = await a.scheduleAt(now + 1200, "B");
    const id3 = await a.scheduleAt(now + 60_000, "C"); // not due

    await new Promise((r) => setTimeout(r, 1300));
    await runDurableObjectAlarm(a);

    const fired = await a.drainFiredSchedules();
    expect(fired.map((f) => f.id).sort()).toEqual([id1, id2].sort());

    const remaining = await a.listSchedules();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(id3);

    await a.terminate();
  });

  it("cron coalesces multiple missed ticks into one fire with coalescedTicks > 1", async () => {
    const a = stub("sc-cron-coalesce");
    await a.spawn({ id: "sc-cron-coalesce", domain: "test" });

    // Seed the storage directly with a cron whose nextFireAt is 10
    // minutes in the past. This simulates a DO that was offline
    // across many cron ticks. The onAlarm handler should fire it
    // ONCE and record `coalescedTicks` equal to the number of ticks
    // missed, then advance nextFireAt to the future.
    const now = Date.now();
    const tenMinutesAgo = now - 10 * 60 * 1000;

    await runInDurableObject(a, async (_inst, ctx) => {
      const schedule: StoredSchedule = {
        id: "seeded-cron",
        type: "cron",
        cron: "* * * * *", // every minute
        payload: { tag: "coalesced" },
        nextFireAt: tenMinutesAgo,
        createdAt: tenMinutesAgo,
      };
      await ctx.storage.put("__schedules__", [schedule]);
      // Arm the alarm to now so the test trigger fires.
      await ctx.storage.setAlarm(now);
    });

    await runDurableObjectAlarm(a);

    const fired = await a.drainFiredSchedules();
    expect(fired).toHaveLength(1);
    expect(fired[0]?.id).toBe("seeded-cron");
    expect(fired[0]?.type).toBe("cron");
    // "* * * * *" every minute, 10 minutes past due → ~10 missed ticks.
    expect(fired[0]?.coalescedTicks).toBeGreaterThanOrEqual(9);
    expect(fired[0]?.coalescedTicks).toBeLessThanOrEqual(12);
    expect(fired[0]?.payload).toEqual({ tag: "coalesced" });

    // Cron schedule stays active with a strictly-future nextFireAt.
    const remaining = await a.listSchedules();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.nextFireAt).toBeGreaterThan(now);

    await a.terminate();
  });

  it("scheduling methods require spawn (MRD-CF-LC-002)", async () => {
    const a = stub("sc-before-spawn");
    await expect(a.scheduleAt(Date.now() + 2000)).rejects.toThrow(
      /MRD-CF-LC-002/,
    );
    await expect(a.scheduleCron("* * * * *")).rejects.toThrow(/MRD-CF-LC-002/);
    await expect(a.listSchedules()).rejects.toThrow(/MRD-CF-LC-002/);
  });
});
