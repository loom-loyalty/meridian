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
    const senderId = ctx.uniqueId("tr-bc-sender");
    const r1Id = ctx.uniqueId("tr-bc-r1");
    const r2Id = ctx.uniqueId("tr-bc-r2");
    const sender = runtime.agent(senderId);
    const r1 = runtime.agent(r1Id);
    const r2 = runtime.agent(r2Id);

    await sender.spawn({ id: senderId, domain: "broadcast-domain" });
    await r1.spawn({ id: r1Id, domain: "broadcast-domain" });
    await r2.spawn({ id: r2Id, domain: "broadcast-domain" });

    const receipt = await sender.broadcast(
      {},
      new TextEncoder().encode("hello"),
    );
    expect(receipt.recipientCount, "recipientCount").toBe(2);

    expect((await r1.receiveAll()).length, "r1 inbox").toBe(1);
    expect((await r2.receiveAll()).length, "r2 inbox").toBe(1);
    expect((await sender.receiveAll()).length, "sender self-deliver").toBe(0);

    // Empty-domain broadcast.
    const aloneId = ctx.uniqueId("tr-bc-alone");
    const alone = runtime.agent(aloneId);
    await alone.spawn({ id: aloneId, domain: "empty-domain" });
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
