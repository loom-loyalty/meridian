/**
 * M3b review follow-up: tests for the new hook-invocation paths in
 * `createTestRuntime`. The M3b PR added `onSpawn` / `onMessage` /
 * `onTerminate` dispatch so the in-memory runtime matches the CF
 * adapter's hook semantics — these tests verify the dispatch
 * actually fires.
 *
 * Existing `hooks.test.ts` covers the CF adapter via Miniflare.
 * This file covers the in-memory path so silent regressions in the
 * `createTestRuntime` hook wiring get caught locally (without a
 * Miniflare boot).
 *
 * Pattern: register a spec with hooks that write sentinel values
 * into state, exercise the RPC that should trigger the hook, then
 * assert the sentinel landed.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { defineAgent } from "../src/define-agent.js";
import { createTestRuntime } from "../src/testing/create-test-runtime.js";

beforeAll(() => {
  // onSpawn writes a sentinel + arms a cron. Exercises the path
  // already covered by the M3b example test, repeated here for
  // completeness in one place.
  defineAgent({
    id: "im-hook-onspawn",
    domain: "test",
    async onSpawn(ctx) {
      await ctx.state.save("spawn-fired", { at: ctx.id });
      await ctx.schedule.cron("* * * * *");
    },
  });

  // onMessage writes the received payload so the test can read it
  // back. If this hook doesn't fire, the "received" key stays unset
  // and the assertion fails.
  defineAgent({
    id: "im-hook-onmessage",
    domain: "test",
    async onMessage(ctx, msg) {
      await ctx.state.save("received", {
        from: msg.fromAgentId,
        text: new TextDecoder().decode(msg.payload),
      });
    },
  });
  defineAgent({ id: "im-hook-sender", domain: "test" });

  // onMessage for broadcast recipients. Uses ctx.state.update (the
  // generic function-form) to exercise the closure path in buildContext.
  defineAgent({
    id: "im-hook-bc-r1",
    domain: "bc",
    async onMessage(ctx) {
      await ctx.state.update<number>("count", (c) => (c ?? 0) + 1);
    },
  });
  defineAgent({
    id: "im-hook-bc-r2",
    domain: "bc",
    async onMessage(ctx) {
      await ctx.state.update<number>("count", (c) => (c ?? 0) + 1);
    },
  });
  defineAgent({ id: "im-hook-bc-sender", domain: "bc" });

  // onTerminate emits via transport (to a witness agent) so we can
  // verify the hook fired BEFORE state was wiped.
  defineAgent({ id: "im-hook-witness", domain: "test" });
  defineAgent({
    id: "im-hook-onterminate",
    domain: "test",
    async onTerminate(ctx) {
      await ctx.transport.send(
        "im-hook-witness",
        new TextEncoder().encode(`bye from ${ctx.id}`),
      );
    },
  });

  // Throwing hook: verifies that a throw inside the hook doesn't
  // break the RPC that triggered it (parity with CF adapter's
  // emitHookError swallowing behavior).
  defineAgent({
    id: "im-hook-throws",
    domain: "test",
    async onSpawn() {
      throw new Error("boom from onSpawn");
    },
  });
});

describe("createTestRuntime hook invocation (M3b parity)", () => {
  it("onSpawn fires and can write state + arm schedules", async () => {
    const rt = createTestRuntime();
    const agent = rt.agent("im-hook-onspawn");
    await agent.spawn({ id: "im-hook-onspawn", domain: "test" });

    expect(await agent.load("spawn-fired")).toEqual({ at: "im-hook-onspawn" });

    const schedules = await agent.listSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.type).toBe("cron");

    await agent.terminate();
  });

  it("onMessage fires on recipient when sender.send() lands a message", async () => {
    const rt = createTestRuntime();
    const recipient = rt.agent("im-hook-onmessage");
    const sender = rt.agent("im-hook-sender");
    await recipient.spawn({ id: "im-hook-onmessage", domain: "test" });
    await sender.spawn({ id: "im-hook-sender", domain: "test" });

    await sender.send(
      "im-hook-onmessage",
      new TextEncoder().encode("hello in-memory"),
    );

    // Hook ran AFTER inbox write, so the sentinel is present.
    expect(await recipient.load("received")).toEqual({
      from: "im-hook-sender",
      text: "hello in-memory",
    });

    await recipient.terminate();
    await sender.terminate();
  });

  it("onMessage fires per recipient on broadcast (generic state.update works inside hooks)", async () => {
    const rt = createTestRuntime();
    const sender = rt.agent("im-hook-bc-sender");
    const r1 = rt.agent("im-hook-bc-r1");
    const r2 = rt.agent("im-hook-bc-r2");
    await sender.spawn({ id: "im-hook-bc-sender", domain: "bc" });
    await r1.spawn({ id: "im-hook-bc-r1", domain: "bc" });
    await r2.spawn({ id: "im-hook-bc-r2", domain: "bc" });

    await sender.broadcast({}, new TextEncoder().encode("ping"));
    await sender.broadcast({}, new TextEncoder().encode("ping"));

    // Each broadcast fires onMessage on r1 + r2, so each sees 2 bumps.
    expect(await r1.load<number>("count")).toBe(2);
    expect(await r2.load<number>("count")).toBe(2);

    await sender.terminate();
    await r1.terminate();
    await r2.terminate();
  });

  it("onTerminate fires BEFORE state wipe (transport.send still works inside hook)", async () => {
    const rt = createTestRuntime();
    const witness = rt.agent("im-hook-witness");
    const dying = rt.agent("im-hook-onterminate");
    await witness.spawn({ id: "im-hook-witness", domain: "test" });
    await dying.spawn({ id: "im-hook-onterminate", domain: "test" });

    await dying.terminate();

    const inbox = await witness.receiveAll();
    expect(inbox).toHaveLength(1);
    expect(new TextDecoder().decode(inbox[0]?.payload)).toBe(
      "bye from im-hook-onterminate",
    );
    expect(inbox[0]?.fromAgentId).toBe("im-hook-onterminate");

    await witness.terminate();
  });

  it("onTerminate is idempotent — a second terminate() does NOT re-fire the hook", async () => {
    const rt = createTestRuntime();
    const witness = rt.agent("im-hook-witness");
    const dying = rt.agent("im-hook-onterminate");
    await witness.spawn({ id: "im-hook-witness", domain: "test" });
    await dying.spawn({ id: "im-hook-onterminate", domain: "test" });

    await dying.terminate();
    await dying.terminate(); // second call should be a no-op

    const inbox = await witness.receiveAll();
    expect(inbox).toHaveLength(1); // only the FIRST terminate fired the hook

    await witness.terminate();
  });

  it("hook throws don't bubble — spawn() resolves even when onSpawn throws", async () => {
    const rt = createTestRuntime();
    const agent = rt.agent("im-hook-throws");

    // If the throw bubbled, this would reject. The in-memory runtime
    // matches the CF adapter's swallow-and-log behavior (the CF side
    // routes through emitHookError; the in-memory side silently
    // swallows since it has no obs backend).
    const handle = await agent.spawn({
      id: "im-hook-throws",
      domain: "test",
    });
    expect(handle.id).toBe("im-hook-throws");

    // Subsequent RPCs still work — the agent exists despite the throw.
    expect(await agent.exists()).toBe(true);

    await agent.terminate();
  });
});
