/**
 * "Why" line generation for the reference priority engine.
 *
 * Format (PRIORITY-ENGINE-SPEC.md §8.6):
 *   #{rank} because {dominant-factor-summary}{ • optional-budget-annotation}
 *
 * The budget annotation appears when the domain's spend ratio exceeds 0.8.
 * A staleness warning appears when the budget reading is older than 60s.
 */

import type {
  WorkItem,
  CompetingContext,
  Domain,
  Timestamp,
} from "@loom-loyalty/meridian-types";

export interface ExplainContext {
  rank: number;
  workItem: WorkItem;
  competingContexts?: CompetingContext[];
  regressionDaysSinceClosed?: number;
  domain?: Domain;
  /** When the domain budget was last observed. Used for staleness warning. */
  domainBudgetReadAt?: Timestamp;
  /** `Date.now()` at the time the explanation is produced. */
  now?: Timestamp;
}

const BUDGET_RATIO_ANNOTATION_THRESHOLD = 0.8;
const BUDGET_STALENESS_THRESHOLD_MS = 60_000;

/**
 * Render the "why" line for a prioritized work item.
 *
 * The format aims to be scannable by a human steward reading a board: rank,
 * the one or two facts that dominated the score, and (when relevant) a
 * budget-state annotation.
 */
export function explain(ctx: ExplainContext): string {
  const now = ctx.now ?? Date.now();
  const summary = dominantFactorSummary(ctx);
  // Prefer the DomainBudget.lastUpdatedAt field when set; fall back to the
  // per-call ExplainContext override so existing callers keep working.
  const readAt = ctx.domain?.budget?.lastUpdatedAt ?? ctx.domainBudgetReadAt;
  const budget = budgetAnnotation(ctx.domain, readAt, now);

  return budget
    ? `#${ctx.rank} because ${summary} • ${budget}`
    : `#${ctx.rank} because ${summary}`;
}

function dominantFactorSummary(ctx: ExplainContext): string {
  const parts: string[] = [];

  const revenue = dominantRevenueAmount(ctx.workItem, ctx.competingContexts);
  if (revenue > 0) parts.push(`revenue at risk ${formatUsd(revenue)}`);

  const blast = dominantBlastRadius(ctx.competingContexts);
  if (blast) parts.push(`blast ${blast}`);

  const affected = dominantAffectedConsumers(ctx.competingContexts);
  if (affected > 0) parts.push(`affected users ${affected}`);

  if (typeof ctx.regressionDaysSinceClosed === "number") {
    parts.push(
      `regression — first fix lasted ${ctx.regressionDaysSinceClosed}d`,
    );
  }

  if (ctx.workItem.confidence >= 0.9) {
    parts.push(`confidence ${ctx.workItem.confidence.toFixed(2)}`);
  }

  parts.push(`cost ${formatUsd(ctx.workItem.costToBuild.amountUsd)}`);

  return parts.join(", ");
}

function dominantRevenueAmount(
  workItem: WorkItem,
  contexts: CompetingContext[] | undefined,
): number {
  const fromWorkItem = workItem.costOfNotBuilding.breakdown?.revenueImpact ?? 0;
  const fromContext = contexts?.reduce(
    (sum, c) => sum + (c.impact.revenueAtRiskUsd ?? 0),
    0,
  );
  return Math.max(fromWorkItem, fromContext ?? 0);
}

function dominantAffectedConsumers(
  contexts: CompetingContext[] | undefined,
): number {
  if (!contexts) return 0;
  return contexts.reduce(
    (sum, c) => sum + (c.impact.affectedConsumers ?? 0),
    0,
  );
}

/** Take the strongest blast-radius label present. Order: system > domain > service > module > isolated. */
function dominantBlastRadius(
  contexts: CompetingContext[] | undefined,
): string | null {
  if (!contexts || contexts.length === 0) return null;
  const order: CompetingContext["impact"]["blastRadius"][] = [
    "system",
    "domain",
    "service",
    "module",
    "isolated",
  ];
  for (const label of order) {
    if (contexts.some((c) => c.impact.blastRadius === label)) return label;
  }
  return null;
}

function budgetAnnotation(
  domain: Domain | undefined,
  readAt: Timestamp | undefined,
  now: Timestamp,
): string | null {
  if (!domain?.budget) return null;

  const { monthlyLimitUsd, currentSpendUsd } = domain.budget;
  if (monthlyLimitUsd <= 0) return null;

  const ratio = currentSpendUsd / monthlyLimitUsd;
  if (ratio < BUDGET_RATIO_ANNOTATION_THRESHOLD) return null;

  const pct = Math.round(ratio * 100);
  const stale =
    readAt !== undefined && now - readAt > BUDGET_STALENESS_THRESHOLD_MS
      ? ` (budget reading ${Math.round((now - readAt) / 60_000)}min stale)`
      : "";

  return `note: ${domain.id} at ${pct}% of monthly cap${stale}`;
}

function formatUsd(amount: number): string {
  if (amount >= 1_000) {
    return `$${Math.round(amount / 100) / 10}k`;
  }
  return `$${amount.toFixed(0)}`;
}
