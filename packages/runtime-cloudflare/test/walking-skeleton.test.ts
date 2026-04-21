/**
 * M1/M2a walking-skeleton test.
 *
 * Exercises spawn → save → load → send → receive → terminate end-to-end
 * against Miniflare via @cloudflare/vitest-pool-workers. Also covers
 * the M2a additions: SpawnConfig shape, suspend/resume/get/exists, and
 * the idempotence + identity-conflict semantics on the lifecycle.
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

    // Re-spawn with the same identity is a no-op (idempotent).
    const handle2 = await a.spawn({
      id: "skeleton-spawn-a",
      domain: "test",
    });
    expect(handle2.spawnedAt).toBe(handle1.spawnedAt);

    await a.terminate();
  });

  it("rejects spawn that would change a DO's bound identity with MRD-CF-LC-001", async () => {
    const a = stub("skeleton-spawn-conflict");
    await a.spawn({ id: "skeleton-spawn-conflict", domain: "test" });
    await expect(
      a.spawn({ id: "different-agent", domain: "test" }),
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
    await a.spawn({ id: "skeleton-order-a", domain: "test" });
    await b.spawn({ id: "skeleton-order-b", domain: "test" });

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

  it("sendTo before spawn raises MRD-CF-LC-002", async () => {
    const orphan = stub("skeleton-orphan");
    await expect(orphan.sendTo("anyone", new Uint8Array([1]))).rejects.toThrow(
      /MRD-CF-LC-002/,
    );
  });

  it("terminate wipes all state including metadata and inbox", async () => {
    const a = stub("skeleton-term-a");
    const b = stub("skeleton-term-b");
    await a.spawn({ id: "skeleton-term-a", domain: "test" });
    await b.spawn({ id: "skeleton-term-b", domain: "test" });
    await a.save("k", "v");
    await b.sendTo("skeleton-term-a", new TextEncoder().encode("ping"));

    await a.terminate();

    expect(await a.exists()).toBe(false);
    expect(await a.load("k")).toBeUndefined();
    expect(await a.receive()).toEqual([]);

    await b.terminate();
  });
});
