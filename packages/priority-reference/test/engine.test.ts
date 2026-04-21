/**
 * End-to-end engine tests. Covers the happy-path scoring, escalation,
 * circuit-breaker bypass, tie-break determinism, and degenerate inputs.
 */

import { describe, it, expect } from "vitest";
import type {
  AgentPriorityQuery,
  CompetingContext,
  Domain,
  ErrorFeedback,
  WorkItem,
  WorkItemId,
} from "@loom-loyalty/meridian-types";
import { RuntimeError } from "@loom-loyalty/meridian-types";
import { WSJFPriorityEngine, type EngineProviders } from "../src/engine.js";

interface Fixture {
  workItems?: WorkItem[];
  contexts?: Record<WorkItemId, CompetingContext[]>;
  errors?: Record<WorkItemId, ErrorFeedback>;
  domain?: Domain;
  supersededByLineageId?: Record<WorkItemId, WorkItem>;
}

function makeProviders(fixture: Fixture): EngineProviders {
  return {
    async listOpenWorkItems() {
      return fixture.workItems ?? [];
    },
    async getCompetingContexts(id) {
      return fixture.contexts?.[id] ?? [];
    },
    async getLatestError(id) {
      return fixture.errors?.[id];
    },
    async getDomain() {
      return fixture.domain;
    },
    async getSupersededItem(lineage) {
      if (!lineage) return undefined;
      return fixture.supersededByLineageId?.[lineage];
    },
  };
}

function makeDomain(overrides: Partial<Domain> = {}): Domain {
  return {
    id: "infrastructure",
    name: "Infrastructure",
    stewards: [{ id: "s1", name: "Steward", role: "primary" }],
    ...overrides,
  };
}

function makeWorkItem(overrides: Partial<WorkItem> & { id: WorkItemId }): WorkItem {
  return {
    type: "story",
    title: "Test",
    domains: ["infrastructure"],
    source: "agent",
    costToBuild: { amountUsd: 50 },
    costOfNotBuilding: { amountUsd: 340 },
    confidence: 0.8,
    status: "ready",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

const query: AgentPriorityQuery = {
  agentId: "pg-agent",
  domain: "infrastructure",
  limit: 10,
};

describe("WSJFPriorityEngine happy path", () => {
  it("returns scored items with explanations, excludes proposed status", async () => {
    const ready = makeWorkItem({ id: "wi_1", status: "ready" });
    const proposed = makeWorkItem({ id: "wi_2", status: "proposed" });
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({
        workItems: [ready, proposed],
        domain: makeDomain(),
      }),
      now: () => 1_500_000,
    });

    const resp = await engine.query(query);
    expect(resp.items).toHaveLength(1);
    expect(resp.items[0].workItem.id).toBe("wi_1");
    expect(resp.items[0].priorityScore).toBeGreaterThan(0);
    expect(resp.items[0].explanation).toContain("#1");
  });

  it("orders by score descending", async () => {
    const a = makeWorkItem({
      id: "wi_a",
      costToBuild: { amountUsd: 10 },
      costOfNotBuilding: { amountUsd: 1000 },
    });
    const b = makeWorkItem({
      id: "wi_b",
      costToBuild: { amountUsd: 1000 },
      costOfNotBuilding: { amountUsd: 10 },
    });
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({ workItems: [a, b], domain: makeDomain() }),
      now: () => 1_500_000,
    });
    const resp = await engine.query(query);
    expect(resp.items[0].workItem.id).toBe("wi_a");
    expect(resp.items[1].workItem.id).toBe("wi_b");
    expect(resp.items[0].priorityScore).toBeGreaterThan(resp.items[1].priorityScore!);
  });

  it("deterministic tie-break by createdAt asc then id asc", async () => {
    const a = makeWorkItem({ id: "wi_a", createdAt: 100 });
    const b = makeWorkItem({ id: "wi_b", createdAt: 100 });
    const c = makeWorkItem({ id: "wi_c", createdAt: 50 });
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({ workItems: [a, b, c], domain: makeDomain() }),
      now: () => 200,
    });
    const resp = await engine.query(query);
    expect(resp.items.map((i) => i.workItem.id)).toEqual(["wi_c", "wi_a", "wi_b"]);
  });
});

describe("WSJFPriorityEngine escalation", () => {
  it("returns null score + annotation when CompetingContext exceeds module blast", async () => {
    const wi = makeWorkItem({ id: "wi_1" });
    const ctx: CompetingContext = {
      sourceAgentId: "ux-agent",
      contestedWorkItemId: "wi_1",
      concern: "sla_risk",
      impact: { blastRadius: "service" },
      argument: "service-wide impact",
      confidence: 0.8,
    };
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({
        workItems: [wi],
        contexts: { wi_1: [ctx] },
        domain: makeDomain(),
      }),
      now: () => 1_500_000,
    });

    const resp = await engine.query(query);
    expect(resp.items[0].priorityScore).toBeNull();
    expect(resp.items[0].priorityAnnotation).toBe("escalated");
    expect(resp.pendingReviewReasons).toHaveLength(1);
  });

  it("does NOT escalate for module blast radius (auto-factored)", async () => {
    const wi = makeWorkItem({ id: "wi_1" });
    const ctx: CompetingContext = {
      sourceAgentId: "ux-agent",
      contestedWorkItemId: "wi_1",
      concern: "sla_risk",
      impact: { blastRadius: "module", revenueAtRiskUsd: 500 },
      argument: "module-local",
      confidence: 0.8,
    };
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({
        workItems: [wi],
        contexts: { wi_1: [ctx] },
        domain: makeDomain(),
      }),
      now: () => 1_500_000,
    });

    const resp = await engine.query(query);
    expect(resp.items[0].priorityScore).not.toBeNull();
    expect(resp.pendingReviewReasons).toBeUndefined();
  });

  it("escalates regardless of low confidence when blast radius is system", async () => {
    const wi = makeWorkItem({ id: "wi_1" });
    const ctx: CompetingContext = {
      sourceAgentId: "rogue-agent",
      contestedWorkItemId: "wi_1",
      concern: "sla_risk",
      impact: { blastRadius: "system" },
      argument: "spooky",
      confidence: 0.1,
    };
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({
        workItems: [wi],
        contexts: { wi_1: [ctx] },
        domain: makeDomain(),
      }),
      now: () => 1_500_000,
    });

    const resp = await engine.query(query);
    expect(resp.items[0].priorityAnnotation).toBe("escalated");
  });
});

describe("WSJFPriorityEngine circuit-breaker", () => {
  it("bypasses normal scoring for critical + all_customers + !recovered", async () => {
    const wi = makeWorkItem({ id: "wi_1" });
    const err: ErrorFeedback = {
      tier: "required",
      type: "error",
      agentId: "pg-agent",
      severity: "critical",
      category: "infrastructure",
      message: "db down",
      frequency: "first",
      blastRadius: "all_customers",
      recovered: false,
      timestamp: 1_500_000,
    };
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({
        workItems: [wi],
        errors: { wi_1: err },
        domain: makeDomain(),
      }),
      now: () => 1_500_000,
    });

    const resp = await engine.query(query);
    expect(resp.items[0].priorityScore).toBeNull();
    expect(resp.items[0].priorityAnnotation).toBe("circuit_breaker");
  });
});

describe("WSJFPriorityEngine degenerate inputs", () => {
  it("rejects negative costOfNotBuilding with INVALID_ARGUMENT", async () => {
    const wi = makeWorkItem({
      id: "wi_1",
      costOfNotBuilding: { amountUsd: -1 },
    });
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({ workItems: [wi], domain: makeDomain() }),
      now: () => 1_500_000,
    });

    await expect(engine.query(query)).rejects.toThrow(RuntimeError);
  });

  it("rejects confidence outside [0, 1]", async () => {
    const wi = makeWorkItem({ id: "wi_1", confidence: 1.5 });
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({ workItems: [wi], domain: makeDomain() }),
      now: () => 1_500_000,
    });

    await expect(engine.query(query)).rejects.toThrow(RuntimeError);
  });

  it("rejects query with unknown domain as NOT_FOUND", async () => {
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({ workItems: [], domain: undefined }),
      now: () => 1_500_000,
    });

    await expect(engine.query(query)).rejects.toThrow(RuntimeError);
  });

  it("rejects query with out-of-range limit", async () => {
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({ workItems: [], domain: makeDomain() }),
      now: () => 1_500_000,
    });

    await expect(
      engine.query({ agentId: "a", domain: "infrastructure", limit: 99 })
    ).rejects.toThrow(RuntimeError);
  });

  it("handles empty work queue by returning empty items", async () => {
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({ workItems: [], domain: makeDomain() }),
      now: () => 1_500_000,
    });

    const resp = await engine.query(query);
    expect(resp.items).toEqual([]);
  });

  it("clamps costToBuild < 0.01 in denominator without throwing", async () => {
    const wi = makeWorkItem({
      id: "wi_1",
      costToBuild: { amountUsd: 0 },
      costOfNotBuilding: { amountUsd: 100 },
    });
    const engine = new WSJFPriorityEngine({
      providers: makeProviders({ workItems: [wi], domain: makeDomain() }),
      now: () => 1_500_000,
    });

    const resp = await engine.query(query);
    expect(resp.items).toHaveLength(1);
    expect(Number.isFinite(resp.items[0].priorityScore!)).toBe(true);
  });
});
