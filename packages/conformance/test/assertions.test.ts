/**
 * Tests for assertConformantResponse. The conformance helpers need to be
 * right — they're the bar every implementation is measured against, so
 * regressions in them silently let bad implementations pass.
 */

import { describe, it, expect } from "vitest";
import type {
  AgentPriorityQuery,
  AgentPriorityResponse,
  CompetingContext,
  PrioritizedWorkItem,
  WorkItem,
} from "@loom-loyalty/meridian-types";
import { assertConformantResponse } from "../src/priority/assertions.js";

const query: AgentPriorityQuery = {
  agentId: "a1",
  domain: "infrastructure",
  limit: 5,
};

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "wi_test",
    type: "story",
    title: "Test",
    domains: ["infrastructure"],
    source: "agent",
    costToBuild: { amountUsd: 50 },
    costOfNotBuilding: { amountUsd: 100 },
    confidence: 0.8,
    status: "ready",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    ...overrides,
  };
}

function makeItem(
  overrides: Partial<PrioritizedWorkItem> = {},
): PrioritizedWorkItem {
  return {
    workItem: makeWorkItem(),
    priorityScore: 7.5,
    explanation: "#1 because ...",
    ...overrides,
  };
}

function makeResponse(
  overrides: Partial<AgentPriorityResponse> = {},
): AgentPriorityResponse {
  return {
    items: [makeItem()],
    queriedAt: 2_000_000,
    ...overrides,
  };
}

describe("assertConformantResponse — valid shapes", () => {
  it("passes a well-formed single-item response", () => {
    const result = assertConformantResponse(query, makeResponse());
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("passes an empty items response", () => {
    const result = assertConformantResponse(query, makeResponse({ items: [] }));
    expect(result.passed).toBe(true);
  });

  it("passes an escalated-item response with pendingReviewReasons", () => {
    const ctx: CompetingContext = {
      sourceAgentId: "ux",
      contestedWorkItemId: "wi_test",
      concern: "sla_risk",
      impact: { blastRadius: "service" },
      argument: "service-wide impact",
      confidence: 0.8,
    };
    const result = assertConformantResponse(
      query,
      makeResponse({
        items: [
          makeItem({
            priorityScore: null,
            priorityAnnotation: "escalated",
          }),
        ],
        pendingReviewReasons: [ctx],
      }),
    );
    expect(result.passed).toBe(true);
  });

  it("passes a circuit-breaker item (null score, no pendingReviewReasons needed)", () => {
    const result = assertConformantResponse(
      query,
      makeResponse({
        items: [
          makeItem({
            priorityScore: null,
            priorityAnnotation: "circuit_breaker",
          }),
        ],
      }),
    );
    expect(result.passed).toBe(true);
  });

  it("passes a response with a domainBudgetStatus string", () => {
    const result = assertConformantResponse(
      query,
      makeResponse({
        domainBudgetStatus: "infrastructure at 87% of monthly cap",
      }),
    );
    expect(result.passed).toBe(true);
  });
});

describe("assertConformantResponse — structural violations", () => {
  it("fails when items is not an array", () => {
    const result = assertConformantResponse(query, {
      // deliberately wrong shape
      items: "not-an-array",
      queriedAt: 1,
    } as unknown as AgentPriorityResponse);
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.includes("items MUST be an array")),
    ).toBe(true);
  });

  it("fails when items.length exceeds query.limit", () => {
    const tooMany = Array.from({ length: 10 }, (_, i) =>
      makeItem({ workItem: makeWorkItem({ id: `wi_${i}` }) }),
    );
    const result = assertConformantResponse(
      query,
      makeResponse({ items: tooMany }),
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.includes("exceeds query.limit")),
    ).toBe(true);
  });

  it("fails when queriedAt is missing", () => {
    const bad = makeResponse();
    delete (bad as Partial<AgentPriorityResponse>).queriedAt;
    const result = assertConformantResponse(query, bad);
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("queriedAt"))).toBe(true);
  });
});

describe("assertConformantResponse — item-level violations", () => {
  it("fails when workItem is missing", () => {
    const result = assertConformantResponse(
      query,
      makeResponse({
        items: [
          {
            priorityScore: 1,
            explanation: "x",
          } as unknown as PrioritizedWorkItem,
        ],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.includes("workItem"))).toBe(true);
  });

  it("fails when priorityScore is neither number nor null", () => {
    const result = assertConformantResponse(
      query,
      makeResponse({
        items: [
          makeItem({ priorityScore: "high" as unknown as number | null }),
        ],
      }),
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) =>
        v.includes("priorityScore MUST be number | null"),
      ),
    ).toBe(true);
  });

  it("fails when explanation is not a string", () => {
    const result = assertConformantResponse(
      query,
      makeResponse({
        items: [makeItem({ explanation: 42 as unknown as string })],
      }),
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.includes("explanation MUST be a string")),
    ).toBe(true);
  });

  it("fails on unknown priorityAnnotation value", () => {
    const result = assertConformantResponse(
      query,
      makeResponse({
        items: [
          makeItem({
            priorityAnnotation:
              "bogus" as PrioritizedWorkItem["priorityAnnotation"],
          }),
        ],
      }),
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) => v.includes("priorityAnnotation")),
    ).toBe(true);
  });

  it("fails when priorityScore is null but priorityAnnotation is absent", () => {
    const result = assertConformantResponse(
      query,
      makeResponse({
        items: [makeItem({ priorityScore: null })],
      }),
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) =>
        v.includes("null scores MUST be annotated"),
      ),
    ).toBe(true);
  });
});

describe("assertConformantResponse — escalation/pending-review correlation", () => {
  it("fails when escalated item is present but pendingReviewReasons is missing", () => {
    const result = assertConformantResponse(
      query,
      makeResponse({
        items: [
          makeItem({
            priorityScore: null,
            priorityAnnotation: "escalated",
          }),
        ],
        // pendingReviewReasons intentionally missing
      }),
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) =>
        v.includes("pendingReviewReasons MUST be populated"),
      ),
    ).toBe(true);
  });

  it("fails when pendingReviewReasons is present but not an array", () => {
    const result = assertConformantResponse(
      query,
      makeResponse({
        items: [
          makeItem({
            priorityScore: null,
            priorityAnnotation: "escalated",
          }),
        ],
        pendingReviewReasons: "nope" as unknown as CompetingContext[],
      }),
    );
    expect(result.passed).toBe(false);
    expect(
      result.violations.some((v) =>
        v.includes("pendingReviewReasons MUST be an array"),
      ),
    ).toBe(true);
  });
});
