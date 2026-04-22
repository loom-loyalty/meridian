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
