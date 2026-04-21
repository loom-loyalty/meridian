/**
 * Assertion helpers for priority engine response shape.
 *
 * These validations check what the spec requires normatively — field
 * presence and correct typing — and nothing beyond. Ordering, absolute
 * score values, and explanation string format are all out of scope.
 */

import type {
  AgentPriorityQuery,
  AgentPriorityResponse,
  PrioritizedWorkItem,
} from "@loom-loyalty/meridian-types";

export interface ConformanceResult {
  passed: boolean;
  violations: string[];
}

export function assertConformantResponse(
  query: AgentPriorityQuery,
  response: AgentPriorityResponse,
): ConformanceResult {
  const violations: string[] = [];

  if (!Array.isArray(response.items)) {
    violations.push("response.items MUST be an array");
    return { passed: false, violations };
  }

  const limit = Math.min(query.limit ?? 1, 10);
  if (response.items.length > limit) {
    violations.push(
      `response.items.length (${response.items.length}) exceeds query.limit (${limit})`,
    );
  }

  for (const [index, item] of response.items.entries()) {
    violations.push(...validateItem(item, index));
  }

  if (typeof response.queriedAt !== "number") {
    violations.push("response.queriedAt MUST be a Timestamp number");
  }

  const hasEscalated = response.items.some(
    (i) => i.priorityScore === null && i.priorityAnnotation === "escalated",
  );
  if (hasEscalated && response.pendingReviewReasons === undefined) {
    violations.push(
      "response.pendingReviewReasons MUST be populated when any item priorityScore is null with priorityAnnotation='escalated'",
    );
  }

  if (response.pendingReviewReasons !== undefined) {
    if (!Array.isArray(response.pendingReviewReasons)) {
      violations.push(
        "response.pendingReviewReasons MUST be an array when present",
      );
    }
  }

  if (
    response.domainBudgetStatus !== undefined &&
    typeof response.domainBudgetStatus !== "string"
  ) {
    violations.push(
      "response.domainBudgetStatus MUST be a string when present",
    );
  }

  return { passed: violations.length === 0, violations };
}

function validateItem(item: PrioritizedWorkItem, index: number): string[] {
  const v: string[] = [];
  const p = `items[${index}]`;

  if (!item.workItem || typeof item.workItem.id !== "string") {
    v.push(`${p}.workItem MUST be a WorkItem with a string id`);
  }

  if (item.priorityScore !== null && typeof item.priorityScore !== "number") {
    v.push(`${p}.priorityScore MUST be number | null`);
  }

  if (typeof item.explanation !== "string") {
    v.push(`${p}.explanation MUST be a string`);
  }

  if (
    item.priorityAnnotation !== undefined &&
    item.priorityAnnotation !== "regression" &&
    item.priorityAnnotation !== "escalated" &&
    item.priorityAnnotation !== "circuit_breaker"
  ) {
    v.push(
      `${p}.priorityAnnotation, when present, MUST be 'regression' | 'escalated' | 'circuit_breaker'`,
    );
  }

  if (item.priorityScore === null && item.priorityAnnotation === undefined) {
    v.push(
      `${p}.priorityScore is null but priorityAnnotation is absent; null scores MUST be annotated`,
    );
  }

  return v;
}
