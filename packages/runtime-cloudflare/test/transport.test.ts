/**
 * M2c transport primitive tests.
 *
 * Covers:
 *   • send from A→B appends sender-partitioned entry (messageId shape,
 *     sequence number, from/to/payload/receivedAt)
 *   • Two senders to one recipient: per-sender sequence numbers stay
 *     independent; interleaved order preserved via receivedAt
 *   • 1 MB payload limit → MRD-CF-TR-001
 *   • Broadcast to agents in the same domain, skipping the sender
 *   • Broadcast to a domain with no matching agents → MRD-CF-TR-002
 *   • Late-spawned agent does NOT receive a broadcast sent before
 *     it registered
 *   • drainInbox pulls-and-clears, receiveAll snapshots without clear
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { AgentDurableObject } from "../src/agent-do.js";

type AgentStub = DurableObjectStub<AgentDurableObject>;

function stub(id: string): AgentStub {
  return env.AGENT.get(env.AGENT.idFromName(id)) as unknown as AgentStub;
}

describe("transport primitive", () => {
  it("rejects payloads larger than 1 MB with MRD-CF-TR-001", async () => {
    const a = stub("tr-big-a");
    const b = stub("tr-big-b");
    await a.spawn({ id: "tr-big-a", domain: "test" });
    await b.spawn({ id: "tr-big-b", domain: "test" });

    const tooBig = new Uint8Array(1_000_001);
    await expect(a.send("tr-big-b", tooBig)).rejects.toThrow(/MRD-CF-TR-001/);

    await a.terminate();
    await b.terminate();
  });

  it("keeps per-sender sequence numbers independent across senders", async () => {
    const recipient = stub("tr-multi-recv");
    const senderA = stub("tr-multi-a");
    const senderB = stub("tr-multi-b");
    await recipient.spawn({ id: "tr-multi-recv", domain: "test" });
    await senderA.spawn({ id: "tr-multi-a", domain: "test" });
    await senderB.spawn({ id: "tr-multi-b", domain: "test" });

    // Interleave sends from A and B.
    await senderA.send("tr-multi-recv", new TextEncoder().encode("A1"));
    await senderB.send("tr-multi-recv", new TextEncoder().encode("B1"));
    await senderA.send("tr-multi-recv", new TextEncoder().encode("A2"));
    await senderB.send("tr-multi-recv", new TextEncoder().encode("B2"));

    const inbox = await recipient.receiveAll();
    expect(inbox.map((m) => m.messageId)).toEqual([
      "tr-multi-a::1",
      "tr-multi-b::1",
      "tr-multi-a::2",
      "tr-multi-b::2",
    ]);

    // Per-sender ordering holds: A1 before A2, B1 before B2.
    const aMessages = inbox.filter((m) => m.fromAgentId === "tr-multi-a");
    expect(aMessages.map((m) => new TextDecoder().decode(m.payload))).toEqual([
      "A1",
      "A2",
    ]);
    const bMessages = inbox.filter((m) => m.fromAgentId === "tr-multi-b");
    expect(bMessages.map((m) => new TextDecoder().decode(m.payload))).toEqual([
      "B1",
      "B2",
    ]);

    await recipient.terminate();
    await senderA.terminate();
    await senderB.terminate();
  });

  it("drainInbox pulls-and-clears; receiveAll snapshots without clearing", async () => {
    const recv = stub("tr-drain-recv");
    const send = stub("tr-drain-send");
    await recv.spawn({ id: "tr-drain-recv", domain: "test" });
    await send.spawn({ id: "tr-drain-send", domain: "test" });

    await send.send("tr-drain-recv", new TextEncoder().encode("first"));
    await send.send("tr-drain-recv", new TextEncoder().encode("second"));

    const snap = await recv.receiveAll();
    expect(snap).toHaveLength(2);

    // Still there after the snapshot.
    expect(await recv.receiveAll()).toHaveLength(2);

    // Drain clears.
    const drained = await recv.drainInbox();
    expect(drained).toHaveLength(2);
    expect(await recv.receiveAll()).toEqual([]);

    await recv.terminate();
    await send.terminate();
  });

  it("broadcast fans out to matching agents in the same domain, skipping the sender", async () => {
    const sender = stub("tr-bcast-sender");
    const r1 = stub("tr-bcast-r1");
    const r2 = stub("tr-bcast-r2");
    const other = stub("tr-bcast-other");
    await sender.spawn({ id: "tr-bcast-sender", domain: "ops" });
    await r1.spawn({ id: "tr-bcast-r1", domain: "ops" });
    await r2.spawn({ id: "tr-bcast-r2", domain: "ops" });
    await other.spawn({ id: "tr-bcast-other", domain: "product" });

    const receipt = await sender.broadcast(
      {},
      new TextEncoder().encode("hello ops"),
    );
    expect(receipt.broadcastId).toBeTruthy();
    expect(receipt.recipientCount).toBe(2); // r1 + r2, not sender, not other

    // Both ops recipients got the message.
    const r1Inbox = await r1.receiveAll();
    expect(r1Inbox).toHaveLength(1);
    expect(new TextDecoder().decode(r1Inbox[0]?.payload)).toBe("hello ops");

    const r2Inbox = await r2.receiveAll();
    expect(r2Inbox).toHaveLength(1);

    // The product-domain agent did not get it.
    expect(await other.receiveAll()).toEqual([]);

    // Sender doesn't self-deliver.
    expect(await sender.receiveAll()).toEqual([]);

    await sender.terminate();
    await r1.terminate();
    await r2.terminate();
    await other.terminate();
  });

  it("broadcast with no matching agents raises MRD-CF-TR-002", async () => {
    const sender = stub("tr-bcast-empty");
    await sender.spawn({ id: "tr-bcast-empty", domain: "lonely-domain" });

    await expect(
      sender.broadcast({}, new TextEncoder().encode("anyone?")),
    ).rejects.toThrow(/MRD-CF-TR-002/);

    await sender.terminate();
  });

  it("broadcast with explicit selector.domain overrides the sender's domain", async () => {
    const sender = stub("tr-bcast-crossdomain");
    const target = stub("tr-bcast-target");
    await sender.spawn({ id: "tr-bcast-crossdomain", domain: "marketing" });
    await target.spawn({ id: "tr-bcast-target", domain: "engineering" });

    const receipt = await sender.broadcast(
      { domain: "engineering" },
      new TextEncoder().encode("cross-domain hi"),
    );
    expect(receipt.recipientCount).toBe(1);

    const inbox = await target.receiveAll();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.fromAgentId).toBe("tr-bcast-crossdomain");

    await sender.terminate();
    await target.terminate();
  });

  it("inbox partition rejects deliveries past 1024-message cap with MRD-CF-TR-003", async () => {
    const recv = stub("tr-cap-recv");
    const sender = stub("tr-cap-sender");
    await recv.spawn({ id: "tr-cap-recv", domain: "test" });
    await sender.spawn({ id: "tr-cap-sender", domain: "test" });

    // Fill the partition to exactly the cap.
    const body = new Uint8Array([0]); // tiny payload
    for (let i = 0; i < 1024; i++) {
      await sender.send("tr-cap-recv", body);
    }

    // One past the cap → MRD-CF-TR-003
    await expect(sender.send("tr-cap-recv", body)).rejects.toThrow(
      /MRD-CF-TR-003/,
    );

    // Drain releases capacity.
    await recv.drainInbox();
    await sender.send("tr-cap-recv", body);

    await recv.terminate();
    await sender.terminate();
  }, 30_000);

  it("late-spawned agents do NOT receive a prior broadcast", async () => {
    const sender = stub("tr-latespawn-sender");
    const early = stub("tr-latespawn-early");
    await sender.spawn({ id: "tr-latespawn-sender", domain: "late" });
    await early.spawn({ id: "tr-latespawn-early", domain: "late" });

    await sender.broadcast({}, new TextEncoder().encode("before"));
    expect((await early.receiveAll()).length).toBe(1);

    // Spawn a second recipient AFTER the broadcast.
    const late = stub("tr-latespawn-late");
    await late.spawn({ id: "tr-latespawn-late", domain: "late" });

    // Late agent has no prior-broadcast message in its inbox.
    expect(await late.receiveAll()).toEqual([]);

    await sender.terminate();
    await early.terminate();
    await late.terminate();
  });
});
