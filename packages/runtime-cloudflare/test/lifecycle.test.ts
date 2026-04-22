/**
 * M2a lifecycle tests.
 *
 * Covers the six stable lifecycle methods + the @experimental ones
 * that throw UNAVAILABLE. One DO per agent; each test cleans up with
 * terminate() since `isolatedStorage: false` is set on the pool.
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { AgentDurableObject } from "../src/agent-do.js";

type AgentStub = DurableObjectStub<AgentDurableObject>;

function stub(id: string): AgentStub {
  return env.AGENT.get(env.AGENT.idFromName(id)) as unknown as AgentStub;
}

describe("lifecycle", () => {
  it("spawn returns AgentHandle with status=running", async () => {
    const a = stub("lc-spawn");
    const handle = await a.spawn({
      id: "lc-spawn",
      domain: "test",
      metadata: { tag: "demo" },
    });
    expect(handle).toEqual({
      id: "lc-spawn",
      domain: "test",
      status: "running",
      spawnedAt: expect.any(Number),
    });
    await a.terminate();
  });

  it("exists() returns false before spawn and true after", async () => {
    const a = stub("lc-exists");
    expect(await a.exists()).toBe(false);
    await a.spawn({ id: "lc-exists", domain: "test" });
    expect(await a.exists()).toBe(true);
    await a.terminate();
    expect(await a.exists()).toBe(false);
  });

  it("get() before spawn throws MRD-CF-LC-002", async () => {
    const a = stub("lc-get-before-spawn");
    await expect(a.get()).rejects.toThrow(/MRD-CF-LC-002/);
  });

  it("get() after spawn returns the same handle shape", async () => {
    const a = stub("lc-get");
    const spawnHandle = await a.spawn({ id: "lc-get", domain: "test" });
    const getHandle = await a.get();
    expect(getHandle).toEqual(spawnHandle);
    await a.terminate();
  });

  it("suspend → resume round-trips status between running and suspended", async () => {
    const a = stub("lc-suspend");
    await a.spawn({ id: "lc-suspend", domain: "test" });
    expect((await a.get()).status).toBe("running");

    await a.suspend();
    expect((await a.get()).status).toBe("suspended");

    // Second suspend is a no-op (already suspended).
    await a.suspend();
    expect((await a.get()).status).toBe("suspended");

    await a.resume();
    expect((await a.get()).status).toBe("running");

    // Second resume is a no-op (already running).
    await a.resume();
    expect((await a.get()).status).toBe("running");

    await a.terminate();
  });

  it("resume on a terminated agent throws MRD-CF-LC-003", async () => {
    const a = stub("lc-resume-terminated");
    await a.spawn({ id: "lc-resume-terminated", domain: "test" });
    await a.terminate();
    await expect(a.resume()).rejects.toThrow(/MRD-CF-LC-003/);
  });

  it("re-spawning after terminate is allowed and resets state", async () => {
    const a = stub("lc-respawn");
    const first = await a.spawn({ id: "lc-respawn", domain: "test" });
    await a.save("before-term", 1);
    await a.terminate();

    // After terminate, spawn with the same identity succeeds; previous
    // state was wiped by terminate's deleteAll.
    const second = await a.spawn({ id: "lc-respawn", domain: "test" });
    expect(second.spawnedAt).toBeGreaterThanOrEqual(first.spawnedAt);
    expect(await a.load("before-term")).toBeUndefined();

    await a.terminate();
  });

  it("rejects spawn when config.id doesn't match DO name with MRD-CF-LC-005 (sender-identity guard)", async () => {
    const a = stub("lc-identity-real");
    await expect(
      a.spawn({ id: "lc-identity-forged", domain: "test" }),
    ).rejects.toThrow(/MRD-CF-LC-005/);
  });

  it("spawn without id or domain throws MRD-CF-LC-004", async () => {
    const a = stub("lc-missing-required");
    await expect(a.spawn({ id: "", domain: "" })).rejects.toThrow(
      /MRD-CF-LC-004/,
    );
  });

  it("snapshotState throws MRD-CF-EX-001 (unavailable in v0.1)", async () => {
    const a = stub("lc-snapshot");
    await a.spawn({ id: "lc-snapshot", domain: "test" });
    await expect(a.snapshotState()).rejects.toThrow(/MRD-CF-EX-001/);
    await a.terminate();
  });

  it("SpawnConfig.fromSnapshot throws MRD-CF-EX-002", async () => {
    const a = stub("lc-fromsnapshot");
    await expect(
      a.spawn({
        id: "lc-fromsnapshot",
        domain: "test",
        fromSnapshot: "snap_abc",
      }),
    ).rejects.toThrow(/MRD-CF-EX-002/);
  });
});
