/**
 * Walking-skeleton test — end-to-end spawn → save → load → send →
 * receive → terminate against Miniflare via @cloudflare/vitest-pool-workers.
 *
 * M2c update: transport RPC renamed from sendTo/deliver/receive to
 * send/deliver/receiveAll (deliver still exists as the receive-side
 * RPC, but send is the sender-side call). Mailbox is now
 * sender-partitioned internally but the external surface is
 * unchanged at this test level.
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { AgentDurableObject } from "../src/agent-do.js";

type AgentStub = DurableObjectStub<AgentDurableObject>;

function stub(id: string): AgentStub {
  return env.AGENT.get(env.AGENT.idFromName(id)) as unknown as AgentStub;
}

describe("walking skeleton", () => {
  it("spawn persists an AgentHandle and is idempotent for the same identity", async () => {
    const a = stub("skeleton-spawn-a");
    const handle1 = await a.spawn({
      id: "skeleton-spawn-a",
      domain: "test",
    });
    expect(handle1.id).toBe("skeleton-spawn-a");
    expect(handle1.domain).toBe("test");
    expect(handle1.status).toBe("running");
    expect(typeof handle1.spawnedAt).toBe("number");

    const handle2 = await a.spawn({
      id: "skeleton-spawn-a",
      domain: "test",
    });
    expect(handle2.spawnedAt).toBe(handle1.spawnedAt);

    await a.terminate();
  });

  it("rejects spawn where config.id doesn't match the DO name with MRD-CF-LC-005", async () => {
    const a = stub("skeleton-spawn-conflict");
    await expect(
      a.spawn({ id: "different-agent", domain: "test" }),
    ).rejects.toThrow(/MRD-CF-LC-005/);
  });

  it("rejects re-spawn with same id but different domain with MRD-CF-LC-001", async () => {
    const a = stub("skeleton-domain-change");
    await a.spawn({ id: "skeleton-domain-change", domain: "infra" });
    await expect(
      a.spawn({ id: "skeleton-domain-change", domain: "product" }),
    ).rejects.toThrow(/MRD-CF-LC-001/);
    await a.terminate();
  });

  it("save and load round-trip a value under the agent's state namespace", async () => {
    const a = stub("skeleton-state-a");
    await a.spawn({ id: "skeleton-state-a", domain: "test" });
    await a.save("greeting", "hello");
    await a.save("count", 42);
    expect(await a.load("greeting")).toBe("hello");
    expect(await a.load("count")).toBe(42);
    expect(await a.load("absent")).toBeUndefined();
    await a.terminate();
  });

  it("send from A to B lands in B's inbox with from + payload + timestamp", async () => {
    const a = stub("skeleton-send-a");
    const b = stub("skeleton-send-b");
    await a.spawn({ id: "skeleton-send-a", domain: "test" });
    await b.spawn({ id: "skeleton-send-b", domain: "test" });

    const payload = new TextEncoder().encode("hi there");
    const receipt = await a.send("skeleton-send-b", payload);
    expect(receipt.messageId).toBeTruthy();
    expect(typeof receipt.queuedAt).toBe("number");

    const inbox = await b.receiveAll();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.fromAgentId).toBe("skeleton-send-a");
    expect(inbox[0]?.toAgentId).toBe("skeleton-send-b");
    expect(new TextDecoder().decode(inbox[0]?.payload)).toBe("hi there");
    expect(typeof inbox[0]?.receivedAt).toBe("number");

    await a.terminate();
    await b.terminate();
  });

  it("multiple sends preserve per-sender order via sequence numbers", async () => {
    const a = stub("skeleton-order-a");
    const b = stub("skeleton-order-b");
    await a.spawn({ id: "skeleton-order-a", domain: "test" });
    await b.spawn({ id: "skeleton-order-b", domain: "test" });

    await a.send("skeleton-order-b", new TextEncoder().encode("one"));
    await a.send("skeleton-order-b", new TextEncoder().encode("two"));
    await a.send("skeleton-order-b", new TextEncoder().encode("three"));

    const inbox = await b.receiveAll();
    expect(inbox.map((e) => new TextDecoder().decode(e.payload))).toEqual([
      "one",
      "two",
      "three",
    ]);
    // Per-pair sequence numbers are encoded in the messageId.
    expect(inbox.map((e) => e.messageId)).toEqual([
      "skeleton-order-a::1",
      "skeleton-order-a::2",
      "skeleton-order-a::3",
    ]);

    await a.terminate();
    await b.terminate();
  });

  it("send before spawn raises MRD-CF-LC-002", async () => {
    const orphan = stub("skeleton-orphan");
    await expect(orphan.send("anyone", new Uint8Array([1]))).rejects.toThrow(
      /MRD-CF-LC-002/,
    );
  });

  it("terminate wipes all state including metadata and inbox", async () => {
    const a = stub("skeleton-term-a");
    const b = stub("skeleton-term-b");
    await a.spawn({ id: "skeleton-term-a", domain: "test" });
    await b.spawn({ id: "skeleton-term-b", domain: "test" });
    await a.save("k", "v");
    await b.send("skeleton-term-a", new TextEncoder().encode("ping"));

    await a.terminate();

    expect(await a.exists()).toBe(false);
    // Post-terminate, every RPC that touches DO state rejects with
    // MRD-CF-LC-002 — the DO is "dead" until a new spawn re-binds it.
    // This is the same gate pre-spawn RPCs hit, giving adopters a
    // single error code to pattern-match on for "agent not present".
    await expect(a.load("k")).rejects.toThrow(/MRD-CF-LC-002/);
    await expect(a.receiveAll()).rejects.toThrow(/MRD-CF-LC-002/);

    await b.terminate();
  });
});
