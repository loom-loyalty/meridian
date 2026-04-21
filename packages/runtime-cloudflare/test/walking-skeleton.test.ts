/**
 * M1 walking-skeleton test.
 *
 * Exercises spawn → save → load → send → receive → terminate end-to-end
 * against Miniflare via @cloudflare/vitest-pool-workers. The DO RPC
 * surface is the M1 test surface; HTTP/WebSocket routing lands in M2.
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { AgentDurableObject } from "../src/agent-do.js";

type AgentStub = DurableObjectStub<AgentDurableObject>;

function stub(id: string): AgentStub {
  return env.AGENT.get(env.AGENT.idFromName(id)) as unknown as AgentStub;
}

describe("walking skeleton", () => {
  it("spawn persists agent metadata and is idempotent for the same identity", async () => {
    const a = stub("skeleton-spawn-a");
    await a.spawn("skeleton-spawn-a", "test");
    const meta1 = await a.getMeta();
    expect(meta1?.id).toBe("skeleton-spawn-a");
    expect(meta1?.domain).toBe("test");
    expect(typeof meta1?.spawnedAt).toBe("number");

    // Re-spawn with the same identity is a no-op (idempotent).
    await a.spawn("skeleton-spawn-a", "test");
    const meta2 = await a.getMeta();
    expect(meta2?.spawnedAt).toBe(meta1?.spawnedAt);

    await a.terminate();
  });

  it("rejects spawn that would change a DO's bound identity", async () => {
    const a = stub("skeleton-spawn-conflict");
    await a.spawn("skeleton-spawn-conflict", "test");
    await expect(a.spawn("different-agent", "test")).rejects.toThrow(
      /already spawned/,
    );
    await a.terminate();
  });

  it("save and load round-trip a value under the agent's state namespace", async () => {
    const a = stub("skeleton-state-a");
    await a.spawn("skeleton-state-a", "test");
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
    await a.spawn("skeleton-send-a", "test");
    await b.spawn("skeleton-send-b", "test");

    const payload = new TextEncoder().encode("hi there");
    await a.sendTo("skeleton-send-b", payload);

    const inbox = await b.receive();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.fromAgentId).toBe("skeleton-send-a");
    expect(new TextDecoder().decode(inbox[0]?.payload)).toBe("hi there");
    expect(typeof inbox[0]?.receivedAt).toBe("number");

    await a.terminate();
    await b.terminate();
  });

  it("multiple sends accumulate in the inbox in arrival order", async () => {
    const a = stub("skeleton-order-a");
    const b = stub("skeleton-order-b");
    await a.spawn("skeleton-order-a", "test");
    await b.spawn("skeleton-order-b", "test");

    await a.sendTo("skeleton-order-b", new TextEncoder().encode("one"));
    await a.sendTo("skeleton-order-b", new TextEncoder().encode("two"));
    await a.sendTo("skeleton-order-b", new TextEncoder().encode("three"));

    const inbox = await b.receive();
    expect(inbox.map((e) => new TextDecoder().decode(e.payload))).toEqual([
      "one",
      "two",
      "three",
    ]);

    await a.terminate();
    await b.terminate();
  });

  it("sendTo before spawn raises", async () => {
    const orphan = stub("skeleton-orphan");
    await expect(orphan.sendTo("anyone", new Uint8Array([1]))).rejects.toThrow(
      /before spawn/,
    );
  });

  it("terminate wipes all state including metadata and inbox", async () => {
    const a = stub("skeleton-term-a");
    const b = stub("skeleton-term-b");
    await a.spawn("skeleton-term-a", "test");
    await b.spawn("skeleton-term-b", "test");
    await a.save("k", "v");
    await b.sendTo("skeleton-term-a", new TextEncoder().encode("ping"));

    await a.terminate();

    expect(await a.getMeta()).toBeUndefined();
    expect(await a.load("k")).toBeUndefined();
    expect(await a.receive()).toEqual([]);

    await b.terminate();
  });
});
