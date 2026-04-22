/**
 * M2c defineAgent hook tests.
 *
 * `defineAgent` registers hooks (onSpawn, onMessage, onTerminate) in a
 * module-level registry. When an AgentDurableObject's RPC methods
 * fire, it looks up the spec by agent id and invokes the hooks. The
 * hooks run INSIDE the DO isolate — tests verify their effects via
 * state reads after the RPC completes, since the test isolate
 * can't directly observe the DO isolate's in-memory state.
 *
 * Pattern: each hook under test writes a sentinel via `ctx.state.save`
 * that the test then reads back through a normal `load` RPC.
 */

import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import type { AgentDurableObject } from "../src/agent-do.js";
import { defineAgent } from "../src/define-agent.js";

type AgentStub = DurableObjectStub<AgentDurableObject>;

function stub(id: string): AgentStub {
  return env.AGENT.get(env.AGENT.idFromName(id)) as unknown as AgentStub;
}

// Spec registrations happen at module-load time so the DO's
// `getAgentSpec()` lookup finds them on first access. Each test uses
// a unique agent id so specs don't collide.
beforeAll(() => {
  defineAgent({
    id: "hook-onspawn",
    domain: "test",
    async onSpawn(ctx) {
      await ctx.state.save("onSpawn-fired", {
        agentId: ctx.id,
        domain: ctx.domain,
        at: Date.now(),
      });
    },
  });

  defineAgent({
    id: "hook-onmessage",
    domain: "test",
    async onMessage(ctx, msg) {
      // Record the last message received so the test can assert.
      await ctx.state.save("onMessage-last", {
        from: msg.fromAgentId,
        payload: new TextDecoder().decode(msg.payload),
        at: Date.now(),
      });
    },
  });

  defineAgent({ id: "hook-onmessage-sender", domain: "test" });

  defineAgent({
    id: "hook-onterminate",
    domain: "test",
    async onTerminate(ctx) {
      // We can't write state — terminate's deleteAll wipes it —
      // but we can reach out via transport to notify a peer. Use
      // it as an inside-the-DO signal path.
      await ctx.transport.send(
        "hook-onterminate-witness",
        new TextEncoder().encode(`terminate:${ctx.id}`),
      );
    },
  });

  defineAgent({ id: "hook-onterminate-witness", domain: "test" });

  defineAgent({
    id: "hook-update-in-message",
    domain: "test",
    async onMessage(ctx) {
      // Exercise the generic update(key, fn) path — this only works
      // INSIDE the DO (function can't cross DO RPC). Hook runs
      // in-process, so it does work.
      await ctx.state.update<number>("counter", (c) => (c ?? 0) + 1);
    },
  });

  defineAgent({ id: "hook-update-sender", domain: "test" });

  defineAgent({
    id: "hook-onschedule",
    domain: "test",
    async onSchedule(ctx, fire) {
      // Record the firing so the test can inspect it without
      // depending on drainFiredSchedules (which the hook path
      // consumes the log through anyway).
      await ctx.state.save("onSchedule-fires", [
        ...((await ctx.state.load<
          Array<{ id: string; coalescedTicks: number; payload: unknown }>
        >("onSchedule-fires")) ?? []),
        {
          id: fire.id,
          coalescedTicks: fire.coalescedTicks,
          payload: fire.payload,
        },
      ]);
    },
  });
});

describe("defineAgent hooks", () => {
  it("onSpawn fires after spawn persists and can write state", async () => {
    const a = stub("hook-onspawn");
    const handle = await a.spawn({
      id: "hook-onspawn",
      domain: "test",
    });

    const signal = await a.load<{
      agentId: string;
      domain: string;
      at: number;
    }>("onSpawn-fired");

    expect(signal).toBeDefined();
    expect(signal?.agentId).toBe("hook-onspawn");
    expect(signal?.domain).toBe("test");
    expect(signal?.at).toBeGreaterThanOrEqual(handle.spawnedAt);

    await a.terminate();
  });

  it("onMessage fires after deliver and can write state inside the DO", async () => {
    const recipient = stub("hook-onmessage");
    const sender = stub("hook-onmessage-sender");
    await recipient.spawn({ id: "hook-onmessage", domain: "test" });
    await sender.spawn({ id: "hook-onmessage-sender", domain: "test" });

    await sender.send("hook-onmessage", new TextEncoder().encode("hello hook"));

    const lastMsg = await recipient.load<{
      from: string;
      payload: string;
      at: number;
    }>("onMessage-last");

    expect(lastMsg).toBeDefined();
    expect(lastMsg?.from).toBe("hook-onmessage-sender");
    expect(lastMsg?.payload).toBe("hello hook");

    await recipient.terminate();
    await sender.terminate();
  });

  it("onTerminate fires before deleteAll and can call transport.send", async () => {
    const witness = stub("hook-onterminate-witness");
    const dying = stub("hook-onterminate");
    await witness.spawn({ id: "hook-onterminate-witness", domain: "test" });
    await dying.spawn({ id: "hook-onterminate", domain: "test" });

    await dying.terminate();

    // The onTerminate hook sent a terminate notice to the witness.
    const inbox = await witness.receiveAll();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.fromAgentId).toBe("hook-onterminate");
    expect(new TextDecoder().decode(inbox[0]?.payload)).toBe(
      "terminate:hook-onterminate",
    );

    await witness.terminate();
  });

  it("hooks can invoke the generic update(key, fn) (function stays in-process)", async () => {
    const recv = stub("hook-update-in-message");
    const sender = stub("hook-update-sender");
    await recv.spawn({ id: "hook-update-in-message", domain: "test" });
    await sender.spawn({ id: "hook-update-sender", domain: "test" });

    // Each message increments the counter via ctx.state.update.
    await sender.send("hook-update-in-message", new Uint8Array([1]));
    await sender.send("hook-update-in-message", new Uint8Array([2]));
    await sender.send("hook-update-in-message", new Uint8Array([3]));

    expect(await recv.load<number>("counter")).toBe(3);

    await recv.terminate();
    await sender.terminate();
  });

  it("onSchedule fires once per due entry, coalescing counts propagate", async () => {
    const a = stub("hook-onschedule");
    await a.spawn({ id: "hook-onschedule", domain: "test" });

    // Real-time schedule at ~1.1s out; wait + trigger alarm.
    const when = Date.now() + 1100;
    await a.scheduleAt(when, { tag: "once" });

    await new Promise((r) => setTimeout(r, 1200));
    await runDurableObjectAlarm(a);

    const fires =
      await a.load<
        Array<{ id: string; coalescedTicks: number; payload: unknown }>
      >("onSchedule-fires");
    expect(fires).toBeDefined();
    expect(fires).toHaveLength(1);
    expect(fires?.[0]?.coalescedTicks).toBe(1);
    expect(fires?.[0]?.payload).toEqual({ tag: "once" });

    // Because the hook consumed the fired log, the drain RPC
    // returns empty.
    expect(await a.drainFiredSchedules()).toEqual([]);

    await a.terminate();
  });

  it("agents without hooks still spawn / deliver / terminate normally", async () => {
    const a = stub("hook-no-spec");
    // No defineAgent() call for this id — agent-do's hook lookup
    // returns undefined and the DO proceeds without firing hooks.
    await a.spawn({ id: "hook-no-spec", domain: "test" });
    await a.save("plain", "value");
    expect(await a.load("plain")).toBe("value");
    await a.terminate();
  });
});
