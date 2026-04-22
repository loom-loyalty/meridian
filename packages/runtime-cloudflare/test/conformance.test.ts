/**
 * Runtime conformance suite — Miniflare + in-memory parity check.
 *
 * This test replays the same `runtimeScenarios` twice:
 *   1. Against a Miniflare-backed adapter that wraps `env.AGENT` stubs
 *   2. Against the in-memory `createTestRuntime()`
 *
 * Both MUST report the same scenarios passing. Divergence = red build
 * (eng-review decision 2026-04-21). Scenarios that declare
 * `appliesTo: ["real-cf"]` skip cleanly here; the e2e-cloudflare
 * workflow runs them against the CF test account.
 */

import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect } from "vitest";

import {
  runRuntimeConformance,
  runtimeScenarios,
  summarizeConformance,
  type AgentRef,
  type Runtime,
  type ConformanceResult,
} from "@loom-loyalty/meridian-conformance/runtime";

import type { AgentDurableObject } from "../src/agent-do.js";
import { createTestRuntime } from "../src/testing/create-test-runtime.js";

type AgentStub = DurableObjectStub<AgentDurableObject>;

function miniflareRuntime(): Runtime {
  return {
    kind: "miniflare",
    agent(id): AgentRef {
      const stub = env.AGENT.get(
        env.AGENT.idFromName(id),
      ) as unknown as AgentStub;
      // The AgentRef shape is a subset of the DO's RPC surface, so
      // we proxy each method. TypeScript can't verify the one-line
      // passthrough exhaustively, but mismatches surface immediately
      // as runtime errors in the scenarios themselves.
      return {
        spawn: (c) => stub.spawn(c),
        terminate: () => stub.terminate(),
        exists: () => stub.exists(),
        get: () => stub.get(),
        save: (k, v) => stub.save(k, v),
        load: (k) => stub.load(k),
        delete: (k) => stub.delete(k),
        list: (o) => stub.list(o),
        incrementAtomic: (k, d) => stub.incrementAtomic(k, d),
        scheduleAt: (w, p) => stub.scheduleAt(w, p),
        scheduleCron: (c, p) => stub.scheduleCron(c, p),
        cancelSchedule: (sid) => stub.cancelSchedule(sid),
        listSchedules: () => stub.listSchedules(),
        send: (to, p) => stub.send(to, p),
        broadcast: (sel, p) => stub.broadcast(sel, p),
        receiveAll: () => stub.receiveAll(),
        drainInbox: () => stub.drainInbox(),
        setLimits: (l) => stub.setLimits(l),
        getLimits: () => stub.getLimits(),
        getUsage: () => stub.getUsage(),
        reportTokens: (n, attr) => stub.reportTokens(n, attr),
        reportCost: (u, attr) => stub.reportCost(u, attr),
        getUsageByWorkItem: (wid) => stub.getUsageByWorkItem(wid),
        snapshotState: () => stub.snapshotState(),
        setPermissions: () => stub.setPermissions(),
        getPermissions: () => stub.getPermissions(),
      };
    },
    async runAlarm(id) {
      const stub = env.AGENT.get(
        env.AGENT.idFromName(id),
      ) as unknown as AgentStub;
      await runDurableObjectAlarm(stub);
    },
    async sleep(ms) {
      await new Promise((r) => setTimeout(r, ms));
    },
  };
}

function assertAllPassed(
  results: readonly ConformanceResult[],
  label: string,
): void {
  const failed = results.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    const lines = failed.map((f) => `  - ${f.scenario}: ${f.reason}`);
    throw new Error(`${label} conformance failures:\n${lines.join("\n")}`);
  }
}

describe("runtime conformance suite", () => {
  it("passes all Miniflare-applicable scenarios against the CF adapter", async () => {
    const results = await runRuntimeConformance(
      miniflareRuntime(),
      runtimeScenarios,
    );
    // assertAllPassed runs first so we get per-scenario failure
    // reasons instead of just "expected 2 to be 0".
    assertAllPassed(results, "Miniflare");
    const summary = summarizeConformance(results);
    expect(summary.passed).toBeGreaterThan(0);
  }, 120_000);

  it("passes all in-memory-applicable scenarios against createTestRuntime()", async () => {
    const results = await runRuntimeConformance(
      createTestRuntime(),
      runtimeScenarios,
    );
    assertAllPassed(results, "in-memory");
    const summary = summarizeConformance(results);
    expect(summary.passed).toBeGreaterThan(0);
  }, 120_000);

  it("Miniflare and in-memory runtimes have identical pass/skip sets", async () => {
    const [mini, mem] = await Promise.all([
      runRuntimeConformance(miniflareRuntime(), runtimeScenarios),
      runRuntimeConformance(createTestRuntime(), runtimeScenarios),
    ]);

    // Both adapters advertise `kind !== "real-cf"`, so the exact
    // same set of scenarios should be applicable to each.
    const miniKeys = mini.map((r) => `${r.scenario}=${r.status}`).sort();
    const memKeys = mem.map((r) => `${r.scenario}=${r.status}`).sort();
    expect(miniKeys).toEqual(memKeys);
  }, 180_000);
});
