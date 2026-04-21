/**
 * Reference conformance scenarios for priority engines.
 *
 * See specs/patterns/PRIORITY-ENGINE-SPEC.md §7. Implementations must
 * accept these inputs and produce well-typed AgentPriorityResponse
 * objects. Orderings and absolute scores are NOT checked.
 */

import type {
  AgentPriorityQuery,
  CompetingContext,
  Domain,
  ErrorFeedback,
  WorkItem,
} from "@loom-loyalty/meridian-types";

export interface ConformanceScenario {
  name: string;
  description: string;
  /** What the implementation-under-test must pre-load into its world. */
  world: {
    workItems: WorkItem[];
    contexts?: Record<string, CompetingContext[]>;
    errors?: Record<string, ErrorFeedback>;
    domain: Domain;
  };
  query: AgentPriorityQuery;
  /** Declared post-conditions the conformance runner checks after query. */
  expectation:
    | { kind: "non-empty-items" }
    | { kind: "empty-items" }
    | { kind: "escalated-item"; workItemId: string }
    | { kind: "circuit-breaker-item"; workItemId: string }
    | { kind: "not-found" }
    | { kind: "invalid-argument" };
}

const domain: Domain = {
  id: "infrastructure",
  name: "Infrastructure",
  stewards: [{ id: "s1", name: "Steward", role: "primary" }],
};

function makeWorkItem(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    type: "story",
    title: `Test ${id}`,
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

const baseQuery: AgentPriorityQuery = {
  agentId: "conformance-agent",
  domain: "infrastructure",
  limit: 10,
};

export const referenceScenarios: ConformanceScenario[] = [
  {
    name: "basic-query",
    description:
      "Basic query against a non-empty work queue returns non-empty items with well-typed fields.",
    world: {
      workItems: [makeWorkItem("wi_1"), makeWorkItem("wi_2")],
      domain,
    },
    query: baseQuery,
    expectation: { kind: "non-empty-items" },
  },
  {
    name: "empty-result",
    description: "Query against an empty work queue returns an empty items array.",
    world: {
      workItems: [],
      domain,
    },
    query: baseQuery,
    expectation: { kind: "empty-items" },
  },
  {
    name: "escalation-response",
    description:
      "Query against a work item with a service-scale CompetingContext returns priorityScore null with priorityAnnotation='escalated' and pendingReviewReasons populated.",
    world: {
      workItems: [makeWorkItem("wi_1")],
      contexts: {
        wi_1: [
          {
            sourceAgentId: "ux-agent",
            contestedWorkItemId: "wi_1",
            concern: "sla_risk",
            impact: { blastRadius: "service" },
            argument: "service-wide impact",
            confidence: 0.8,
          },
        ],
      },
      domain,
    },
    query: baseQuery,
    expectation: { kind: "escalated-item", workItemId: "wi_1" },
  },
  {
    name: "circuit-breaker",
    description:
      "Query against a work item with critical + all_customers + !recovered error returns priorityScore null with priorityAnnotation='circuit_breaker'.",
    world: {
      workItems: [makeWorkItem("wi_1")],
      errors: {
        wi_1: {
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
        },
      },
      domain,
    },
    query: baseQuery,
    expectation: { kind: "circuit-breaker-item", workItemId: "wi_1" },
  },
  {
    name: "not-found-domain",
    description: "Query against an unknown domain MUST raise NOT_FOUND.",
    world: {
      workItems: [],
      domain,
    },
    query: { ...baseQuery, domain: "nonexistent" },
    expectation: { kind: "not-found" },
  },
  {
    name: "invalid-argument",
    description:
      "Query with an out-of-range limit MUST raise INVALID_ARGUMENT.",
    world: {
      workItems: [],
      domain,
    },
    query: { ...baseQuery, limit: 99 },
    expectation: { kind: "invalid-argument" },
  },
];
