/**
 * Explainer tests. PRIORITY-ENGINE-SPEC.md §8.6.
 */

import { describe, it, expect } from "vitest";
import type {
  CompetingContext,
  Domain,
  WorkItem,
} from "@loom-loyalty/meridian-types";
import { explain } from "../src/explainer.js";

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi_test",
    type: "story",
    title: "Test",
    domains: ["infrastructure"],
    source: "agent",
    costToBuild: { amountUsd: 50 },
    costOfNotBuilding: { amountUsd: 340, breakdown: { debtAccumulation: 340 } },
    confidence: 0.85,
    status: "ready",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<CompetingContext> = {},
): CompetingContext {
  return {
    sourceAgentId: "ux-agent",
    contestedWorkItemId: "wi_test",
    concern: "sla_risk",
    impact: {
      revenueAtRiskUsd: 12_000,
      affectedConsumers: 4800,
      blastRadius: "module",
    },
    argument: "viewport regression",
    confidence: 0.84,
    ...overrides,
  };
}

describe("explain()", () => {
  it("includes rank, revenue, blast, cost", () => {
    const out = explain({
      rank: 1,
      workItem: makeWorkItem(),
      competingContexts: [makeContext()],
    });
    expect(out).toMatch(/^#1 because/);
    expect(out).toContain("revenue at risk $12k");
    expect(out).toContain("blast module");
    expect(out).toContain("cost $50");
  });

  it("includes regression annotation when daysSinceClosed is present", () => {
    const out = explain({
      rank: 2,
      workItem: makeWorkItem(),
      regressionDaysSinceClosed: 3,
    });
    expect(out).toContain("regression — first fix lasted 3d");
  });

  it("includes confidence when >= 0.9", () => {
    const out = explain({
      rank: 3,
      workItem: makeWorkItem({ confidence: 0.91 }),
    });
    expect(out).toContain("confidence 0.91");
  });

  it("omits confidence when < 0.9", () => {
    const out = explain({
      rank: 4,
      workItem: makeWorkItem({ confidence: 0.8 }),
    });
    expect(out).not.toContain("confidence");
  });

  it("adds budget annotation when domain ratio exceeds 0.8", () => {
    const domain: Domain = {
      id: "infrastructure",
      name: "Infra",
      stewards: [{ id: "s1", name: "Steward", role: "primary" }],
      budget: {
        monthlyLimitUsd: 10_000,
        currentSpendUsd: 8_500,
        alertThreshold: 0.8,
      },
    };
    const now = 1_000_000;
    const readAt = now - 30_000; // 30s stale, below threshold
    const out = explain({
      rank: 1,
      workItem: makeWorkItem(),
      domain,
      domainBudgetReadAt: readAt,
      now,
    });
    expect(out).toContain("infrastructure at 85% of monthly cap");
    expect(out).not.toContain("stale");
  });

  it("adds staleness warning when budget reading exceeds 60s", () => {
    const domain: Domain = {
      id: "infrastructure",
      name: "Infra",
      stewards: [{ id: "s1", name: "Steward", role: "primary" }],
      budget: {
        monthlyLimitUsd: 10_000,
        currentSpendUsd: 9_500,
        alertThreshold: 0.8,
      },
    };
    const now = 1_000_000;
    const readAt = now - 12 * 60_000; // 12min stale
    const out = explain({
      rank: 1,
      workItem: makeWorkItem(),
      domain,
      domainBudgetReadAt: readAt,
      now,
    });
    expect(out).toContain("budget reading 12min stale");
  });

  it("omits budget when ratio below 0.8", () => {
    const domain: Domain = {
      id: "infrastructure",
      name: "Infra",
      stewards: [{ id: "s1", name: "Steward", role: "primary" }],
      budget: {
        monthlyLimitUsd: 10_000,
        currentSpendUsd: 500,
        alertThreshold: 0.8,
      },
    };
    const out = explain({
      rank: 1,
      workItem: makeWorkItem(),
      domain,
    });
    expect(out).not.toContain("of monthly cap");
  });
});
