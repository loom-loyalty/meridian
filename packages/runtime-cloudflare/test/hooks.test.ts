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
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
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

  // Throwing hooks: verify the DO survives the throw and the
  // hook-error observability surface fires (A3 of M2d review).
  defineAgent({
    id: "hook-throws-onspawn",
    domain: "test",
    async onSpawn() {
      throw new Error("boom-spawn");
    },
  });
  defineAgent({
    id: "hook-throws-onmessage",
    domain: "test",
    async onMessage() {
      throw new Error("boom-message");
    },
  });
  defineAgent({ id: "hook-throws-onmessage-sender", domain: "test" });
  defineAgent({
    id: "hook-throws-onschedule",
    domain: "test",
    async onSchedule() {
      throw new Error("boom-schedule");
    },
  });
  defineAgent({
    id: "hook-throws-onterminate",
    domain: "test",
    async onTerminate() {
      throw new Error("boom-terminate");
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

  // ── A3: hook-error observability ────────────────────────────
  //
  // Throwing hooks emit `meridian.hook.errors` metric + a
  // structured error log with ErrorFeedback-shaped fields. The
  // CF test pool proxies DO-side console output through the test
  // isolate's console, so `vi.spyOn(console, 'error')` catches
  // the emit from `CloudflareLogsPlugin.log({level:'error'})`.
  // We also assert "DO stays alive after a hook throws" as a
  // behavior-level regression guard.

  describe("A3 hook-error observability", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    afterEach(() => {
      errorSpy?.mockRestore();
    });

    it("onSpawn throw: spawn() resolves, DO stays usable, error surfaced", async () => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const a = stub("hook-throws-onspawn");
      // Spawn must RESOLVE despite the throwing hook (hook errors
      // don't cascade to the DO's RPC caller).
      const handle = await a.spawn({
        id: "hook-throws-onspawn",
        domain: "test",
      });
      expect(handle.id).toBe("hook-throws-onspawn");

      // DO still works — a plain state round-trip proves the
      // isolate wasn't killed by the throw.
      await a.save("survived", "yes");
      expect(await a.load("survived")).toBe("yes");

      // Assert the hook-error log landed in console.error with the
      // ErrorFeedback-shaped payload. We look for the distinctive
      // `hook_error:onSpawn` category string somewhere in the call
      // args (the exact format depends on the JSON stringify path
      // in CloudflareLogsPlugin).
      const calls = errorSpy.mock.calls.flat();
      const asText = calls.map((c) => JSON.stringify(c)).join("\n");
      expect(asText).toMatch(/hook_error:onSpawn/);
      expect(asText).toMatch(/boom-spawn/);

      await a.terminate();
    });

    it("onMessage throw: send() resolves for sender, recipient DO stays usable", async () => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const recipient = stub("hook-throws-onmessage");
      const sender = stub("hook-throws-onmessage-sender");
      await recipient.spawn({ id: "hook-throws-onmessage", domain: "test" });
      await sender.spawn({
        id: "hook-throws-onmessage-sender",
        domain: "test",
      });

      // send() must resolve — hook throws inside the recipient DO
      // are caught and do NOT propagate to the sender.
      const receipt = await sender.send(
        "hook-throws-onmessage",
        new TextEncoder().encode("hi"),
      );
      expect(receipt.messageId).toMatch(/^hook-throws-onmessage-sender::/);

      // Inbox landed even though the hook threw (the hook fires
      // AFTER the storage write).
      const inbox = await recipient.receiveAll();
      expect(inbox).toHaveLength(1);

      const asText = errorSpy.mock.calls
        .flat()
        .map((c) => JSON.stringify(c))
        .join("\n");
      expect(asText).toMatch(/hook_error:onMessage/);
      expect(asText).toMatch(/boom-message/);

      await recipient.terminate();
      await sender.terminate();
    });

    it("onSchedule throw: fire is still ack'd, DO keeps draining remaining fires", async () => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const a = stub("hook-throws-onschedule");
      await a.spawn({ id: "hook-throws-onschedule", domain: "test" });

      const when = Date.now() + 1100;
      await a.scheduleAt(when, { tag: "throwing" });
      await new Promise((r) => setTimeout(r, 1200));
      await runDurableObjectAlarm(a);

      // Hook threw but the fire was ack'd after the caught error —
      // so the polling companion sees an empty log, not a retry.
      // (Only DO crashes between peek and ack trigger redelivery.)
      expect(await a.drainFiredSchedules()).toEqual([]);

      const asText = errorSpy.mock.calls
        .flat()
        .map((c) => JSON.stringify(c))
        .join("\n");
      expect(asText).toMatch(/hook_error:onSchedule/);
      expect(asText).toMatch(/boom-schedule/);

      await a.terminate();
    });

    it("onTerminate throw: terminate() still completes, DO is wiped", async () => {
      errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const a = stub("hook-throws-onterminate");
      await a.spawn({ id: "hook-throws-onterminate", domain: "test" });
      await a.save("pre-term", "value");

      // Terminate must resolve even if the onTerminate hook throws.
      await a.terminate();

      // Post-terminate: exists() returns false.
      expect(await a.exists()).toBe(false);

      const asText = errorSpy.mock.calls
        .flat()
        .map((c) => JSON.stringify(c))
        .join("\n");
      expect(asText).toMatch(/hook_error:onTerminate/);
      expect(asText).toMatch(/boom-terminate/);
    });
  });
});
