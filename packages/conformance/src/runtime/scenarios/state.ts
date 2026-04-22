import type { ConformanceScenario } from "../types.js";
import { expect, expectReject } from "../assertions.js";

export const stateIsolation: ConformanceScenario = {
  name: "state-isolation",
  description:
    "state saved on agent A is not visible on agent B. RUNTIME-SPEC §4.2.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const idA = ctx.uniqueId("st-iso-a");
    const idB = ctx.uniqueId("st-iso-b");
    const a = runtime.agent(idA);
    const b = runtime.agent(idB);

    await a.spawn({ id: idA, domain: "conformance" });
    await b.spawn({ id: idB, domain: "conformance" });

    await a.save("shared-key", { who: "A" });
    expect(await b.load("shared-key"), "B reads A's key").toBeUndefined();

    await a.terminate();
    await b.terminate();
  },
};

export const stateReservedKeys: ConformanceScenario = {
  name: "state-reserved-keys",
  description:
    "keys beginning with `__` are reserved and rejected with MRD-CF-ST-003.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("st-reserved");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });

    await expectReject(
      agent.save("__meta__", "no"),
      /MRD-CF-ST-003/,
      "save reserved key",
    );
    await expectReject(
      agent.load("__anything__"),
      /MRD-CF-ST-003/,
      "load reserved key",
    );

    await agent.terminate();
  },
};

export const stateSizeLimits: ConformanceScenario = {
  name: "state-size-limits",
  description:
    "key > 1024 bytes → MRD-CF-ST-001; value whose JSON encoding > 1 MB → MRD-CF-ST-002.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("st-size");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });

    const longKey = "k".repeat(1025);
    await expectReject(
      agent.save(longKey, "x"),
      /MRD-CF-ST-001/,
      "save long key",
    );

    // Use a control-char payload: U+0001 is 1 UTF-8 byte in memory
    // but JSON.stringify encodes it as the 6-char escape ``, so a
    // 200 KB raw string JSON-stringifies to ~1.2 MB. That exceeds the
    // 1 MB cap our validator checks while keeping the RPC payload small
    // enough to comfortably fit any Workers / DO RPC argument size
    // limit — real CF bounces `"v".repeat(1_000_001)` at the platform
    // boundary before our validation can run. `String.fromCharCode(1)`
    // keeps the source file free of literal control chars.
    const bigValue = String.fromCharCode(1).repeat(200_000);
    await expectReject(
      agent.save("k", bigValue),
      /MRD-CF-ST-002/,
      "save value whose JSON encoding exceeds 1 MB",
    );

    await agent.terminate();
  },
};

export const stateConcurrentUpdate: ConformanceScenario = {
  name: "state-concurrent-update",
  description:
    "incrementAtomic serializes concurrent updates — N parallel calls add up to N. RUNTIME-SPEC §4.2.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const id = ctx.uniqueId("st-concurrent");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });

    const N = 25;
    await Promise.all(
      Array.from({ length: N }, () => agent.incrementAtomic("counter", 1)),
    );
    expect(await agent.load<number>("counter"), "final counter").toBe(N);

    await agent.terminate();
  },
};

export const stateDurability: ConformanceScenario = {
  name: "state-durability",
  description:
    "state survives hibernation — real-CF only; emulated runtimes skip. RUNTIME-SPEC §4.2.",
  appliesTo: ["real-cf"],
  async run(runtime, ctx) {
    // Workers runtime does not expose hibernation triggers to user
    // code. The e2e-cloudflare workflow drives this scenario across
    // a longer gap so the DO gets evicted between write and read;
    // this in-scenario version just asserts round-trip. Skip-gating
    // to real-cf means the Miniflare run never hits this path, so
    // divergence between Miniflare and real-CF on hibernation shows
    // up only in CI where the workflow forces eviction.
    const id = ctx.uniqueId("st-durable");
    const agent = runtime.agent(id);
    await agent.spawn({ id, domain: "conformance" });
    await agent.save("persist-me", { value: "durable" });
    expect(
      (await agent.load<{ value: string }>("persist-me"))?.value,
      "state durability round-trip value",
    ).toBe("durable");
    await agent.terminate();
  },
};
