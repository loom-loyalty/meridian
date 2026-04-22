import type { ConformanceScenario } from "../types.js";
import { expect, expectReject } from "../assertions.js";

export const transportOrdering: ConformanceScenario = {
  name: "transport-ordering",
  description:
    "sender A → recipient R: per-pair messages arrive in send order with monotonic sequence numbers. RUNTIME-SPEC §4.4.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const aId = ctx.uniqueId("tr-ord-a");
    const rId = ctx.uniqueId("tr-ord-r");
    const sender = runtime.agent(aId);
    const recv = runtime.agent(rId);
    await sender.spawn({ id: aId, domain: "conformance" });
    await recv.spawn({ id: rId, domain: "conformance" });

    await sender.send(rId, new TextEncoder().encode("m1"));
    await sender.send(rId, new TextEncoder().encode("m2"));
    await sender.send(rId, new TextEncoder().encode("m3"));

    const inbox = await recv.receiveAll();
    expect(inbox.length, "inbox size").toBe(3);
    // Per-pair order holds.
    expect(
      inbox.map((m) => new TextDecoder().decode(m.payload)),
      "payload order from single sender",
    ).toEqual(["m1", "m2", "m3"]);

    await recv.terminate();
    await sender.terminate();
  },
};

export const transportPayloadLimit: ConformanceScenario = {
  name: "transport-payload-limit",
  description:
    "payload > 1 MB rejects with MRD-CF-TR-001. Real-CF skips because " +
    "sending a 1 MB Uint8Array over DO RPC hits the Workers platform " +
    "argument-size enforcement before our 1 MB validator can run. " +
    "Miniflare + in-memory exercise the validator directly; platform " +
    "behavior is covered by a Workers-specific integration test in M3.",
  appliesTo: ["miniflare", "in-memory"],
  async run(runtime, ctx) {
    const aId = ctx.uniqueId("tr-lim-a");
    const bId = ctx.uniqueId("tr-lim-b");
    const a = runtime.agent(aId);
    const b = runtime.agent(bId);
    await a.spawn({ id: aId, domain: "conformance" });
    await b.spawn({ id: bId, domain: "conformance" });

    const tooBig = new Uint8Array(1_000_001);
    await expectReject(a.send(bId, tooBig), /MRD-CF-TR-001/, "send > 1 MB");

    await a.terminate();
    await b.terminate();
  },
};

export const transportBroadcast: ConformanceScenario = {
  name: "transport-broadcast",
  description:
    "broadcast to a domain fans out to all registered peers, skipping the sender. Empty domain → MRD-CF-TR-002.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    // Per-run unique domain — real-CF persists the registry across
    // workflow runs, and if a prior run's scenario crashed before
    // terminate, those agents leak into the domain forever. Using a
    // uniqueId for the domain makes each run fully isolated.
    const domain = ctx.uniqueId("tr-bc-domain");
    const emptyDomain = ctx.uniqueId("tr-bc-empty-domain");
    const senderId = ctx.uniqueId("tr-bc-sender");
    const r1Id = ctx.uniqueId("tr-bc-r1");
    const r2Id = ctx.uniqueId("tr-bc-r2");
    const sender = runtime.agent(senderId);
    const r1 = runtime.agent(r1Id);
    const r2 = runtime.agent(r2Id);

    await sender.spawn({ id: senderId, domain });
    await r1.spawn({ id: r1Id, domain });
    await r2.spawn({ id: r2Id, domain });

    const receipt = await sender.broadcast(
      {},
      new TextEncoder().encode("hello"),
    );
    expect(receipt.recipientCount, "recipientCount").toBe(2);

    expect((await r1.receiveAll()).length, "r1 inbox").toBe(1);
    expect((await r2.receiveAll()).length, "r2 inbox").toBe(1);
    expect((await sender.receiveAll()).length, "sender self-deliver").toBe(0);

    // Empty-domain broadcast — fresh unique domain so it's guaranteed
    // empty regardless of registry state from prior runs.
    const aloneId = ctx.uniqueId("tr-bc-alone");
    const alone = runtime.agent(aloneId);
    await alone.spawn({ id: aloneId, domain: emptyDomain });
    await expectReject(
      alone.broadcast({}, new TextEncoder().encode("anyone?")),
      /MRD-CF-TR-002/,
      "broadcast empty domain",
    );

    await alone.terminate();
    await sender.terminate();
    await r1.terminate();
    await r2.terminate();
  },
};

export const transportInboxCap: ConformanceScenario = {
  name: "transport-inbox-cap",
  description:
    "per-(sender, recipient) inbox caps at 1024 messages; 1025th rejects with MRD-CF-TR-003. RUNTIME-SPEC §4.4.",
  // Real-CF skipped: 1024 serial RPCs exceed the Worker fetch's CPU
  // envelope on the shared /conformance invocation. Covered by
  // runtime-cloudflare's transport.test.ts inbox-cap case instead.
  appliesTo: ["miniflare", "in-memory"],
  async run(runtime, ctx) {
    const senderId = ctx.uniqueId("tr-cap-s");
    const recvId = ctx.uniqueId("tr-cap-r");
    const sender = runtime.agent(senderId);
    const recv = runtime.agent(recvId);
    await sender.spawn({ id: senderId, domain: "conformance" });
    await recv.spawn({ id: recvId, domain: "conformance" });

    const tiny = new Uint8Array([0]);
    for (let i = 0; i < 1024; i++) {
      await sender.send(recvId, tiny);
    }
    // The 1025th delivery from this sender must reject.
    await expectReject(
      sender.send(recvId, tiny),
      /MRD-CF-TR-003/,
      "1025th send from same sender hits cap",
    );

    // Draining releases capacity; a subsequent send succeeds.
    await recv.drainInbox();
    await sender.send(recvId, tiny);

    await sender.terminate();
    await recv.terminate();
  },
};

export const transportBroadcastCrossDomain: ConformanceScenario = {
  name: "transport-broadcast-cross-domain",
  description:
    "broadcast with explicit selector.domain targets agents in that domain, not the sender's. RUNTIME-SPEC §4.4.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    // Per-run unique domains so real-CF registry accumulation from
    // prior runs doesn't inflate recipientCount.
    const alphaDomain = ctx.uniqueId("tr-cross-alpha");
    const betaDomain = ctx.uniqueId("tr-cross-beta");
    const senderId = ctx.uniqueId("tr-cross-s");
    const targetId = ctx.uniqueId("tr-cross-t");
    const bystanderId = ctx.uniqueId("tr-cross-b");

    const sender = runtime.agent(senderId);
    const target = runtime.agent(targetId);
    const bystander = runtime.agent(bystanderId);

    // Three agents across two domains: sender + bystander in alpha,
    // target in beta (what the broadcast selector targets).
    await sender.spawn({ id: senderId, domain: alphaDomain });
    await target.spawn({ id: targetId, domain: betaDomain });
    await bystander.spawn({ id: bystanderId, domain: alphaDomain });

    const receipt = await sender.broadcast(
      { domain: betaDomain },
      new TextEncoder().encode("cross-domain"),
    );
    expect(receipt.recipientCount, "cross-domain recipientCount").toBe(1);

    expect((await target.receiveAll()).length, "target inbox").toBe(1);
    expect(
      (await bystander.receiveAll()).length,
      "bystander in sender's own domain — not targeted",
    ).toBe(0);
    expect((await sender.receiveAll()).length, "sender self-deliver").toBe(0);

    await sender.terminate();
    await target.terminate();
    await bystander.terminate();
  },
};

export const transportBroadcastLateSpawn: ConformanceScenario = {
  name: "transport-broadcast-late-spawn",
  description:
    "agents spawned AFTER a broadcast do not receive the earlier message. RUNTIME-SPEC §4.4: 'matches selector at time of call; late-spawned agents don't receive'.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    // Per-run unique domain for the same reason as transport-broadcast
    // — real-CF registry persists across workflow runs.
    const domain = ctx.uniqueId("tr-late-domain");
    const senderId = ctx.uniqueId("tr-late-s");
    const firstId = ctx.uniqueId("tr-late-first");
    const lateId = ctx.uniqueId("tr-late-late");

    const sender = runtime.agent(senderId);
    const first = runtime.agent(firstId);

    await sender.spawn({ id: senderId, domain });
    await first.spawn({ id: firstId, domain });

    const receipt = await sender.broadcast(
      {},
      new TextEncoder().encode("before-late-spawn"),
    );
    expect(receipt.recipientCount, "broadcast recipientCount").toBe(1);
    expect((await first.receiveAll()).length, "first agent received").toBe(1);

    // Late-spawn AFTER the broadcast.
    const late = runtime.agent(lateId);
    await late.spawn({ id: lateId, domain });
    expect(
      (await late.receiveAll()).length,
      "late agent has empty inbox (not retroactive)",
    ).toBe(0);

    await sender.terminate();
    await first.terminate();
    await late.terminate();
  },
};

export const transportDrain: ConformanceScenario = {
  name: "transport-drain",
  description:
    "receiveAll snapshots without clearing; drainInbox pulls-and-clears.",
  appliesTo: ["miniflare", "real-cf", "in-memory"],
  async run(runtime, ctx) {
    const senderId = ctx.uniqueId("tr-drain-s");
    const recvId = ctx.uniqueId("tr-drain-r");
    const sender = runtime.agent(senderId);
    const recv = runtime.agent(recvId);
    await sender.spawn({ id: senderId, domain: "conformance" });
    await recv.spawn({ id: recvId, domain: "conformance" });

    await sender.send(recvId, new Uint8Array([1]));
    await sender.send(recvId, new Uint8Array([2]));

    expect((await recv.receiveAll()).length, "first receiveAll").toBe(2);
    expect(
      (await recv.receiveAll()).length,
      "second receiveAll snapshots",
    ).toBe(2);
    expect((await recv.drainInbox()).length, "drain clears").toBe(2);
    expect((await recv.receiveAll()).length, "post-drain empty").toBe(0);

    await sender.terminate();
    await recv.terminate();
  },
};
