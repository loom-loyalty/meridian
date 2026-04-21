/**
 * Reference priority engine.
 *
 * Implements the WSJF-derived formula documented in
 * specs/patterns/PRIORITY-ENGINE-SPEC.md §8. Non-normative — other
 * implementations may produce different scores or orderings for the same
 * inputs and still be Meridian-conformant (conformance checks response
 * shape, not ordering).
 */

import type {
  AgentPriorityQuery,
  AgentPriorityResponse,
  CompetingContext,
  CostEstimate,
  Domain,
  ErrorFeedback,
  PrioritizedWorkItem,
  PriorityLearner,
  WeightProfile,
  WorkItem,
  WorkItemId,
} from "@loom-loyalty/meridian-types";
import { RuntimeError } from "@loom-loyalty/meridian-types";
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  shouldTripCircuitBreaker,
} from "./circuit-breaker.js";
import { NoOpLearner } from "./no-op-learner.js";
import { explain, type ExplainContext } from "./explainer.js";
import { resolveWeightProfile } from "./weight-profiles.js";

const MS_PER_DAY = 86_400_000;
const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 10;

const SEVERITY_WEIGHT: Record<ErrorFeedback["severity"], number> = {
  critical: 4,
  high: 2,
  medium: 1,
  low: 0.5,
};

const FREQUENCY_WEIGHT: Record<ErrorFeedback["frequency"], number> = {
  first: 1,
  recurring: 1.5,
  escalating: 3,
};

/** Escalating blast radii (CompetingContext values). */
const ESCALATING_BLAST_RADII = new Set<
  CompetingContext["impact"]["blastRadius"]
>(["service", "domain", "system"]);

/**
 * State the engine queries via its injected providers. These are small
 * accessor functions rather than a full runtime object so this package
 * stays decoupled from any specific Meridian runtime.
 */
export interface EngineProviders {
  /** Return open work items for the given domain (all proposed/researching/ready/in_progress/...). */
  listOpenWorkItems(domainId: string): Promise<WorkItem[]>;
  /** Return any CompetingContext objects attached to the given work item. */
  getCompetingContexts(workItemId: WorkItemId): Promise<CompetingContext[]>;
  /** Return the freshest correlated ErrorFeedback for the given work item, if any. */
  getLatestError(workItemId: WorkItemId): Promise<ErrorFeedback | undefined>;
  /** Return the Domain object (for per-domain config + budget annotations). */
  getDomain(domainId: string): Promise<Domain | undefined>;
  /** Return a recently closed work item superseded by the given lineage id, if any. */
  getSupersededItem(
    lineageId: WorkItemId | undefined,
  ): Promise<WorkItem | undefined>;
}

export interface EngineOptions {
  providers: EngineProviders;
  /** When omitted, a NoOpLearner is installed. */
  learner?: PriorityLearner;
  /** `Date.now` injection for deterministic tests. */
  now?: () => number;
}

export class WSJFPriorityEngine {
  private readonly providers: EngineProviders;
  private readonly learner: PriorityLearner;
  private readonly now: () => number;

  constructor(opts: EngineOptions) {
    this.providers = opts.providers;
    this.learner = opts.learner ?? new NoOpLearner();
    this.now = opts.now ?? Date.now;
  }

  async query(q: AgentPriorityQuery): Promise<AgentPriorityResponse> {
    this.validateQuery(q);
    const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const includeExplanation = q.includeExplanation ?? true;

    const domain = await this.providers.getDomain(q.domain);
    if (!domain) {
      throw new RuntimeError("not_found", `domain not found: ${q.domain}`);
    }

    const allOpen = await this.providers.listOpenWorkItems(q.domain);
    const eligible = allOpen.filter((wi) => wi.status !== "proposed");

    const weights = resolveWeightProfile(
      domain.priorityConfig?.weightProfileId,
    );
    const breakerConfig =
      domain.priorityConfig?.circuitBreakerConfig ??
      DEFAULT_CIRCUIT_BREAKER_CONFIG;

    const scored: PrioritizedWorkItem[] = [];
    const pendingReviewReasons: CompetingContext[] = [];

    for (const wi of eligible) {
      this.validateWorkItem(wi);
      const contexts = await this.providers.getCompetingContexts(wi.id);
      const err = await this.providers.getLatestError(wi.id);

      // Circuit breaker: bypass scoring
      if (err && shouldTripCircuitBreaker(err, breakerConfig)) {
        const expl = includeExplanation
          ? `emergency: ${err.severity}/${err.blastRadius}, not recovered`
          : "";
        scored.push({
          workItem: wi,
          priorityScore: null,
          priorityAnnotation: "circuit_breaker",
          explanation: expl,
        });
        continue;
      }

      // Escalation: CompetingContext above module blast radius
      const escalatingContexts = contexts.filter((c) =>
        ESCALATING_BLAST_RADII.has(c.impact.blastRadius),
      );
      if (escalatingContexts.length > 0) {
        pendingReviewReasons.push(...escalatingContexts);
        const expl = includeExplanation
          ? `escalated: ${escalatingContexts.length} competing context(s) above module`
          : "";
        scored.push({
          workItem: wi,
          priorityScore: null,
          priorityAnnotation: "escalated",
          explanation: expl,
        });
        continue;
      }

      // Normal scoring path
      const superseded = await this.providers.getSupersededItem(wi.lineage);
      const regressionDaysSinceClosed = regressionDays(
        wi,
        superseded,
        this.now,
      );
      const score = this.scoreWorkItem(
        wi,
        contexts,
        err,
        weights,
        regressionDaysSinceClosed,
      );

      const expl = includeExplanation
        ? explain({
            rank: scored.length + 1,
            workItem: wi,
            competingContexts: contexts,
            regressionDaysSinceClosed,
            domain,
            now: this.now(),
          } satisfies ExplainContext)
        : "";

      scored.push({
        workItem: wi,
        priorityScore: score,
        priorityAnnotation:
          regressionDaysSinceClosed !== undefined ? "regression" : undefined,
        explanation: expl,
      });

      this.learner.onDecision(wi.id, score);
    }

    // Sort: non-null scores descending; null-score items (circuit/escalation) sink to the bottom.
    // Tie-break by createdAt asc, then id lex asc.
    scored.sort((a, b) => {
      if (a.priorityScore === null && b.priorityScore === null) {
        return tieBreak(a.workItem, b.workItem);
      }
      if (a.priorityScore === null) return 1;
      if (b.priorityScore === null) return -1;
      if (a.priorityScore !== b.priorityScore)
        return b.priorityScore - a.priorityScore;
      return tieBreak(a.workItem, b.workItem);
    });

    return {
      items: scored.slice(0, limit),
      pendingReviewReasons:
        pendingReviewReasons.length > 0 ? pendingReviewReasons : undefined,
      domainBudgetStatus: this.budgetStatus(domain),
      queriedAt: this.now(),
    };
  }

  private validateQuery(q: AgentPriorityQuery): void {
    if (!q.agentId || !q.domain) {
      throw new RuntimeError(
        "invalid_argument",
        "agentId and domain are required",
      );
    }
    if (q.limit !== undefined && (q.limit < 1 || q.limit > MAX_LIMIT)) {
      throw new RuntimeError(
        "invalid_argument",
        `limit must be between 1 and ${MAX_LIMIT}`,
      );
    }
  }

  private validateWorkItem(wi: WorkItem): void {
    if (wi.costOfNotBuilding.amountUsd < 0) {
      throw new RuntimeError(
        "invalid_argument",
        `costOfNotBuilding.amountUsd must be >= 0 (work item ${wi.id})`,
      );
    }
    if (wi.confidence < 0 || wi.confidence > 1) {
      throw new RuntimeError(
        "invalid_argument",
        `confidence must be in [0.0, 1.0] (work item ${wi.id})`,
      );
    }
  }

  private scoreWorkItem(
    wi: WorkItem,
    contexts: CompetingContext[],
    err: ErrorFeedback | undefined,
    weights: Required<Omit<WeightProfile, "id">> & { id: string },
    regressionDaysSinceClosed: number | undefined,
  ): number {
    const costOfNotBuildingUsd =
      wi.costOfNotBuilding.amountUsd * weights.costOfNotBuildingWeight;
    const riskReductionUsd = wi.costOfNotBuilding.breakdown?.riskExposure ?? 0;
    const timeCriticalityUsd = this.timeCriticality(wi, err, weights);

    const impactUnitless = this.impactTerm(
      wi.costOfNotBuilding,
      contexts,
      weights,
    );

    const confidence = wi.confidence * weights.confidenceMultiplier;

    const denominator = Math.max(wi.costToBuild.amountUsd, 0.01);

    const base =
      ((costOfNotBuildingUsd + timeCriticalityUsd + riskReductionUsd) *
        (1 + impactUnitless * weights.impactWeight) *
        confidence) /
      denominator;

    const regressionMultiplier =
      regressionDaysSinceClosed !== undefined
        ? Math.min(
            weights.regressionMultiplierCap,
            1 + 1 / Math.max(regressionDaysSinceClosed, 1),
          )
        : 1.0;

    return base * regressionMultiplier;
  }

  private timeCriticality(
    wi: WorkItem,
    err: ErrorFeedback | undefined,
    weights: Required<Omit<WeightProfile, "id">> & { id: string },
  ): number {
    if (!err) return 0;
    const ageDays = (this.now() - wi.createdAt) / MS_PER_DAY;
    const raw =
      ageDays *
      SEVERITY_WEIGHT[err.severity] *
      FREQUENCY_WEIGHT[err.frequency] *
      weights.usdPerDayWeight *
      weights.timeCriticalityWeight;
    const cap = wi.costOfNotBuilding.amountUsd * weights.timeCriticalityCap;
    return Math.min(raw, cap);
  }

  private impactTerm(
    costOfNotBuilding: CostEstimate,
    contexts: CompetingContext[],
    weights: Required<Omit<WeightProfile, "id">> & { id: string },
  ): number {
    const revenueFromContexts = contexts.reduce(
      (sum, c) => sum + (c.impact.revenueAtRiskUsd ?? 0),
      0,
    );
    const consumersFromContexts = contexts.reduce(
      (sum, c) => sum + (c.impact.affectedConsumers ?? 0),
      0,
    );
    const consumerRevenue =
      consumersFromContexts * weights.usdPerAffectedConsumer;
    const impactUsd = revenueFromContexts + consumerRevenue;
    const denominator = Math.max(costOfNotBuilding.amountUsd, 0.01);
    return impactUsd / denominator;
  }

  private budgetStatus(domain: Domain): string | undefined {
    if (!domain.budget) return undefined;
    const { currentSpendUsd, monthlyLimitUsd } = domain.budget;
    if (monthlyLimitUsd <= 0) return undefined;
    const ratio = currentSpendUsd / monthlyLimitUsd;
    if (ratio < 0.8) return undefined;
    return `${domain.id} at ${Math.round(ratio * 100)}% of monthly cap`;
  }
}

function tieBreak(a: WorkItem, b: WorkItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function regressionDays(
  _wi: WorkItem,
  superseded: WorkItem | undefined,
  now: () => number,
): number | undefined {
  if (!superseded || superseded.status !== "done") return undefined;
  const closedAt = superseded.updatedAt;
  const days = (now() - closedAt) / MS_PER_DAY;
  return days >= 0 ? days : undefined;
}
