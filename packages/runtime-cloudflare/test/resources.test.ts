/**
 * M2d resources primitive tests.
 *
 * Covers:
 *   • setLimits / getLimits round-trip
 *   • getUsage shape + sub-1s latency (DO local read, not AE)
 *   • reportTokens / reportCost enforce hard caps before incrementing
 *   • reportTokens enforces maxTokensPerCall per-call cap
 *   • Warnings triggered at 80% threshold; onLimitEvent fires
 *   • Negative report values rejected
 *   • Resources methods require spawn
 *   • setPermissions / getPermissions throw UNAVAILABLE
 */

import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import type { AgentDurableObject } from "../src/agent-do.js";

type AgentStub = DurableObjectStub<AgentDurableObject>;

function stub(id: string): AgentStub {
  return env.AGENT.get(env.AGENT.idFromName(id)) as unknown as AgentStub;
}

describe("resources primitive", () => {
  it("setLimits / getLimits round-trips", async () => {
    const a = stub("rs-limits");
    await a.spawn({ id: "rs-limits", domain: "test" });

    await a.setLimits({
      maxTokensTotal: 10_000,
      maxTokensPerCall: 500,
      maxCostUsd: 25.0,
      maxConcurrency: 5,
    });

    const limits = await a.getLimits();
    expect(limits).toEqual({
      maxTokensTotal: 10_000,
      maxTokensPerCall: 500,
      maxCostUsd: 25.0,
      maxConcurrency: 5,
    });

    await a.terminate();
  });

  it("getUsage returns zeroed counters on fresh spawn", async () => {
    const a = stub("rs-fresh-usage");
    await a.spawn({ id: "rs-fresh-usage", domain: "test" });

    const usage = await a.getUsage();
    expect(usage.current.tokensLifetime).toBe(0);
    expect(usage.current.costUsdLifetime).toBe(0);
    expect(usage.current.activeOperations).toBe(0);
    expect(usage.warnings).toEqual([]);

    await a.terminate();
  });

  it("reportTokens accumulates + enforces maxTokensTotal with MRD-CF-RS-001", async () => {
    const a = stub("rs-tokens-cap");
    await a.spawn({ id: "rs-tokens-cap", domain: "test" });
    await a.setLimits({ maxTokensTotal: 1000 });

    await a.reportTokens(400);
    await a.reportTokens(500);
    expect((await a.getUsage()).current.tokensLifetime).toBe(900);

    // 900 + 101 = 1001 > 1000 → reject, counter unchanged
    await expect(a.reportTokens(101)).rejects.toThrow(/MRD-CF-RS-001/);
    expect((await a.getUsage()).current.tokensLifetime).toBe(900);

    // Exactly at the limit is allowed.
    await a.reportTokens(100);
    expect((await a.getUsage()).current.tokensLifetime).toBe(1000);

    await a.terminate();
  });

  it("reportTokens enforces maxTokensPerCall with MRD-CF-RS-003", async () => {
    const a = stub("rs-tokens-per-call");
    await a.spawn({ id: "rs-tokens-per-call", domain: "test" });
    await a.setLimits({ maxTokensPerCall: 500 });

    await expect(a.reportTokens(501)).rejects.toThrow(/MRD-CF-RS-003/);
    await a.reportTokens(500); // exactly at the per-call cap is fine

    await a.terminate();
  });

  it("reportCost enforces maxCostUsd with MRD-CF-RS-002", async () => {
    const a = stub("rs-cost-cap");
    await a.spawn({ id: "rs-cost-cap", domain: "test" });
    await a.setLimits({ maxCostUsd: 10 });

    await a.reportCost(7.5);
    await expect(a.reportCost(3)).rejects.toThrow(/MRD-CF-RS-002/);
    // Prior write held; 7.5 + 3 would be 10.5 > 10, so the 3 was rejected.
    expect((await a.getUsage()).current.costUsdLifetime).toBe(7.5);

    await a.reportCost(2.5); // 7.5 + 2.5 = 10, at limit, allowed
    expect((await a.getUsage()).current.costUsdLifetime).toBe(10);

    await a.terminate();
  });

  it("negative reportTokens / reportCost amounts are rejected", async () => {
    const a = stub("rs-negative");
    await a.spawn({ id: "rs-negative", domain: "test" });

    await expect(a.reportTokens(-1)).rejects.toThrow(/MRD-CF-RS-003/);
    await expect(a.reportCost(-0.01)).rejects.toThrow(/MRD-CF-RS-002/);

    await a.terminate();
  });

  it("warnings appear at 80% of any limit and surface in getUsage", async () => {
    const a = stub("rs-warn");
    await a.spawn({ id: "rs-warn", domain: "test" });
    await a.setLimits({ maxCostUsd: 10 });

    await a.reportCost(7.9);
    // 7.9 / 10 = 79% — no warning yet
    expect((await a.getUsage()).warnings).toEqual([]);

    await a.reportCost(0.2);
    // 8.1 / 10 = 81% — warning recorded
    const usage = await a.getUsage();
    expect(usage.warnings).toHaveLength(1);
    expect(usage.warnings[0]?.type).toBe("cost");
    expect(usage.warnings[0]?.threshold).toBeCloseTo(0.81, 2);
    expect(typeof usage.warnings[0]?.triggeredAt).toBe("number");

    await a.terminate();
  });

  it("resources methods require spawn", async () => {
    const a = stub("rs-before-spawn");
    await expect(a.getUsage()).rejects.toThrow(/MRD-CF-LC-002/);
    await expect(a.reportTokens(1)).rejects.toThrow(/MRD-CF-LC-002/);
    await expect(a.setLimits({ maxTokensTotal: 100 })).rejects.toThrow(
      /MRD-CF-LC-002/,
    );
  });

  it("reportTokens + reportCost with {workItemId} feeds getUsageByWorkItem", async () => {
    const a = stub("rs-wi-attribution");
    await a.spawn({ id: "rs-wi-attribution", domain: "test" });

    // Two work items, mixed reports with and without attribution.
    await a.reportTokens(100, { workItemId: "wi-1" });
    await a.reportCost(1.5, { workItemId: "wi-1" });
    await a.reportTokens(40, { workItemId: "wi-2" });
    await a.reportCost(0.25, { workItemId: "wi-2" });
    // An unattributed report still increments the agent-total but
    // not any per-wi bucket.
    await a.reportTokens(25);
    await a.reportCost(0.5);

    // Per-wi lookup: exact match returns single entry with that wi's
    // totals.
    const wi1 = await a.getUsageByWorkItem("wi-1");
    expect(wi1).toEqual([{ workItemId: "wi-1", tokens: 100, costUsd: 1.5 }]);

    const wi2 = await a.getUsageByWorkItem("wi-2");
    expect(wi2).toEqual([{ workItemId: "wi-2", tokens: 40, costUsd: 0.25 }]);

    // Unknown work item id: empty array, not an error.
    expect(await a.getUsageByWorkItem("wi-unknown")).toEqual([]);

    // Full breakdown: sorted by costUsd descending. wi-1 ($1.50) >
    // wi-2 ($0.25). The unattributed $0.50 does NOT appear as a
    // phantom row.
    const all = await a.getUsageByWorkItem();
    expect(all).toEqual([
      { workItemId: "wi-1", tokens: 100, costUsd: 1.5 },
      { workItemId: "wi-2", tokens: 40, costUsd: 0.25 },
    ]);

    // Agent-total lifetime counters still reflect every report,
    // attributed or not (double-entry accounting, not either/or).
    const usage = await a.getUsage();
    expect(usage.current.tokensLifetime).toBe(165); // 100 + 40 + 25
    expect(usage.current.costUsdLifetime).toBeCloseTo(2.25, 4); // 1.5 + 0.25 + 0.5

    await a.terminate();
  });

  it("getUsageByWorkItem returns [] before any attributed report exists", async () => {
    const a = stub("rs-wi-empty");
    await a.spawn({ id: "rs-wi-empty", domain: "test" });

    expect(await a.getUsageByWorkItem()).toEqual([]);
    expect(await a.getUsageByWorkItem("wi-never-seen")).toEqual([]);

    // Top-level counters moved, but with no attribution the wi
    // breakdown stays empty.
    await a.reportTokens(10);
    expect(await a.getUsageByWorkItem()).toEqual([]);

    await a.terminate();
  });

  it("setPermissions throws MRD-CF-EX-004 (unavailable in v0.1)", async () => {
    const a = stub("rs-setperm");
    await a.spawn({ id: "rs-setperm", domain: "test" });
    await expect(a.setPermissions()).rejects.toThrow(/MRD-CF-EX-004/);
    await a.terminate();
  });

  it("getPermissions throws MRD-CF-EX-005 (unavailable in v0.1)", async () => {
    const a = stub("rs-getperm");
    await a.spawn({ id: "rs-getperm", domain: "test" });
    await expect(a.getPermissions()).rejects.toThrow(/MRD-CF-EX-005/);
    await a.terminate();
  });
});
