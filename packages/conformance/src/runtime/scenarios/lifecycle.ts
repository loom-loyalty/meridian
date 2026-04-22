import type { ConformanceScenario } from "../types.js";
import { expect, expectReject } from "../assertions.js";

export const lifecycleBasic: ConformanceScenario = {
  name: "lifecycle-basic",
  description:
    "spawn persists an AgentHandle, exists() reflects state, terminate() wipes. RUNTIME-SPEC §4.1.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("lc-basic");
    const agent = runtime.agent(id);

    expect(await agent.exists(), "exists() pre-spawn").toBe(false);

    const handle = await agent.spawn({ id, domain: "conformance" });
    expect(handle.id, "handle.id").toBe(id);
    expect(handle.domain, "handle.domain").toBe("conformance");
    expect(handle.status, "handle.status").toBe("running");

    expect(await agent.exists(), "exists() post-spawn").toBe(true);

    const fetched = await agent.get();
    expect(fetched.id, "get().id").toBe(id);

    await agent.terminate();
    expect(await agent.exists(), "exists() post-terminate").toBe(false);
  },
};

export const lifecycleIdempotent: ConformanceScenario = {
  name: "lifecycle-idempotent",
  description:
    "re-spawn with same (id,domain) is a no-op; re-spawn with different domain rejects MRD-CF-LC-001.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("lc-idem");
    const agent = runtime.agent(id);

    await agent.spawn({ id, domain: "alpha" });
    // Same (id, domain) MUST not error.
    await agent.spawn({ id, domain: "alpha" });

    // Different domain MUST reject.
    await expectReject(
      agent.spawn({ id, domain: "beta" }),
      /MRD-CF-LC-001/,
      "spawn with different domain",
    );

    await agent.terminate();
  },
};

export const lifecycleRequiresSpawn: ConformanceScenario = {
  name: "lifecycle-requires-spawn",
  description:
    "calling save/send/scheduleAt/getUsage before spawn must reject with MRD-CF-LC-002.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("lc-preflight");
    const agent = runtime.agent(id);

    await expectReject(
      agent.send(id, new Uint8Array([0])),
      /MRD-CF-LC-002/,
      "send before spawn",
    );
    await expectReject(
      agent.scheduleAt(Date.now() + 60_000),
      /MRD-CF-LC-002/,
      "scheduleAt before spawn",
    );
    await expectReject(
      agent.getUsage(),
      /MRD-CF-LC-002/,
      "getUsage before spawn",
    );
  },
};
