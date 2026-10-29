/**
 * Work item schema types.
 * Every unit of work carries two cost estimates in real dollars.
 */

import type { DomainId, WorkItemId, AgentId, Timestamp } from "./primitives.js";
import type { CompetingContext, QualitySignal } from "./quality.js";
import type { ErrorFeedback } from "./feedback.js";
import type { Attribution, NodeTypeId, SpecImpact } from "./knowledge.js";

/**
 * Built-in work item types (stable). The delivery ladder itself is taxonomy
 * data (KNOWLEDGE-SPEC.md §6): the default ladder's `program` and `project`
 * rungs, and any tenant-defined delivery type, map to the nearest of these
 * values, with the tenant type carried in `WorkItem.typeId`.
 */
export type WorkItemType = "initiative" | "epic" | "story" | "task";
export type WorkItemSource = "human" | "agent" | "feedback";
export type WorkItemStatus =
  | "proposed"
  | "researching"
  | "ready"
  | "in_progress"
  | "in_review"
  | "approved"
  | "deploying"
  | "validating"
  | "done"
  | "cancelled";

export interface WorkItem {
  id: WorkItemId;
  type: WorkItemType;
  title: string;
  description?: string;

  /** Which domain(s) this work belongs to. */
  domains: DomainId[];

  /** Who or what created this work item. */
  source: WorkItemSource;
  sourceAgentId?: AgentId;

  /** What feedback, insight, or initiative spawned this. */
  lineage?: WorkItemId;

  /**
   * Containment parent on the delivery ladder (e.g. the epic a story
   * belongs to). Distinct from `lineage`, which records what spawned the
   * item. See WORK-ITEM-SPEC.md §2.1.
   *
   * @experimental
   */
  parentId?: WorkItemId;

  /**
   * Tenant taxonomy node type for this item, when the tenant's ladder uses
   * types beyond the built-in `WorkItemType` values. `type` then carries
   * the nearest built-in value. See KNOWLEDGE-SPEC.md §6.
   *
   * @experimental
   */
  typeId?: NodeTypeId;

  /**
   * Specs and sections this item is expected to change. See
   * KNOWLEDGE-SPEC.md §7.
   *
   * @experimental
   */
  specImpact?: SpecImpact;

  /**
   * The agent currently working this item, under a lease. Absent or
   * expired means unclaimed. See WORK-ITEM-SPEC.md §8.1.
   *
   * @experimental
   */
  claim?: WorkItemClaim;

  /**
   * Links to external evidence: pull requests, branches, CI runs, agent
   * sessions. See WORK-ITEM-SPEC.md §8.2.
   *
   * @experimental
   */
  links?: WorkItemLink[];

  /** Real dollar cost estimates. */
  costToBuild: CostEstimate;
  costOfNotBuilding: CostEstimate;

  /** How confident is the system in the cost estimates. */
  confidence: number; // 0.0 to 1.0

  /** Current status. */
  status: WorkItemStatus;

  /**
   * Implementation-defined priority score. See
   * `specs/patterns/PRIORITY-ENGINE-SPEC.md` for the data contract and
   * `@loom-loyalty/meridian-priority-reference` for the reference formula.
   */
  priorityScore?: number;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A lease an agent holds on a work item while it works it. At most one
 * unexpired claim exists per item. An expired claim is the same as none.
 * See WORK-ITEM-SPEC.md §8.1.
 *
 * @experimental
 */
export interface WorkItemClaim {
  workItemId: WorkItemId;
  /** The agent holding the lease. */
  agentId: AgentId;
  /** The human the agent acts for, if any. */
  onBehalfOf?: string;
  claimedAt: Timestamp;
  /** When the lease lapses unless renewed. */
  leaseExpiresAt: Timestamp;
  /** Lease length granted, in milliseconds; renewals extend by this much. */
  leaseDurationMs?: number;
  /** Last renewal, by an explicit renew or a heartbeat. */
  renewedAt?: Timestamp;
}

/**
 * Kind of external artifact linked to a work item.
 *
 * @experimental
 */
export type WorkItemLinkKind =
  | "pull_request"
  | "branch"
  | "ci_run"
  | "session"
  | "other";

/**
 * A link from a work item to evidence in another system. Links are
 * evidence for reviewers, not gate outcomes. See WORK-ITEM-SPEC.md §8.2.
 *
 * @experimental
 */
export interface WorkItemLink {
  kind: WorkItemLinkKind;
  url: string;
  title?: string;
  /** Who attached the link. Set by the runtime. */
  addedBy?: Attribution;
  addedAt?: Timestamp;
}

export interface CostEstimate {
  amountUsd: number;
  breakdown?: {
    tokens?: number;
    compute?: number;
    humanHours?: number;
    revenueImpact?: number;
    riskExposure?: number;
    debtAccumulation?: number;
  };
  /** Human-readable explanation of how this was estimated. */
  basis?: string;
  /**
   * Domain accountable for this estimate. Encodes the detector/estimator
   * handoff: on costOfNotBuilding this is usually the detecting domain; on
   * costToBuild this is the executing domain. See WORK-ITEM-SPEC.md §6.
   */
  providedBy?: DomainId;
  /** The specific agent that produced this estimate, if any. */
  estimatorAgentId?: AgentId;
  /** When the estimate was produced; used for staleness tracking. */
  estimatedAt?: Timestamp;
}

// -----------------------------------------------------------------------
// Priority engine data contracts
//
// See specs/patterns/PRIORITY-ENGINE-SPEC.md for normative behavior
// (data shapes, escalation mechanism, wire protocol, addressing,
// conformance) and @loom-loyalty/meridian-priority-reference for the
// reference formula implementation.
// -----------------------------------------------------------------------

/** Duration in milliseconds. */
export type Duration = number;

/**
 * Annotation attached to a prioritized work item when the engine applies a
 * special-case rule to it. `"regression"` means lineage matched a recently
 * closed item inside the cooldown window. `"escalated"` means a
 * `CompetingContext` with blast radius above module sent it to steward
 * review. `"circuit_breaker"` means a critical + all_customers + unrecovered
 * error triggered the bypass path.
 */
export type PriorityAnnotation = "regression" | "escalated" | "circuit_breaker";

/**
 * Configuration of how a priority implementation weights its inputs.
 *
 * All numeric fields are advisory. Implementations MAY ignore any or all of
 * them and compute priorities differently. The spec defines a `"default"`
 * profile with every numeric field at `1.0` (and the two `*Cap` fields at
 * `2.0`); conformance tests assume that profile.
 */
export interface WeightProfile {
  id: string;
  costOfNotBuildingWeight?: number;
  timeCriticalityWeight?: number;
  impactWeight?: number;
  confidenceMultiplier?: number;
  /** USD multiplier when CompetingContext.impact.affectedConsumers is used. */
  usdPerAffectedConsumer?: number;
  /** USD multiplier on age-based timeCriticality so the term has USD units. */
  usdPerDayWeight?: number;
  /** Upper bound on the regression priority multiplier. */
  regressionMultiplierCap?: number;
  /** Upper bound on the timeCriticality term as a multiple of costOfNotBuilding. */
  timeCriticalityCap?: number;
}

/**
 * Partial update to a WeightProfile. Returned by a PriorityLearner to
 * suggest weight adjustments based on outcome data.
 *
 * @experimental Shape may stabilize in v1.1.
 */
export type WeightDelta = Partial<Omit<WeightProfile, "id">>;

/**
 * Per-domain priority configuration. Attached to Domain objects
 * (see ../patterns/DOMAIN-SPEC.md) so stewards can tune per-domain.
 */
export interface DomainPriorityConfig {
  /** Which WeightProfile this domain uses. Defaults to `"default"`. */
  weightProfileId?: string;
  circuitBreakerConfig?: CircuitBreakerConfig;
}

/**
 * Circuit-breaker configuration: when an ErrorFeedback signal bypasses
 * the priority engine entirely and escalates straight to the domain
 * steward. See PRIORITY-ENGINE-SPEC.md §3.
 *
 * Default (when unset on a domain): severity=critical, blastRadius
 * includes "all_customers", recovered=false.
 */
export interface CircuitBreakerConfig {
  criticalSeverityThreshold: "critical" | "high";
  /** Values from ErrorFeedback.blastRadius (NOT CompetingContext.blastRadius). */
  bypassBlastRadius: ErrorFeedback["blastRadius"][];
  /** When true, circuit-breaker only fires if the error's recovered flag is false. */
  requireRecoveredFalse: boolean;
  escalationPath: "steward" | "runtime_log_only";
}

/**
 * Request payload for the PRIORITY_QUERY wire message (wire type 0x40).
 * Sent from an agent to the domain-local priority engine via the
 * well-known recipient `"__priority__"`.
 */
export interface AgentPriorityQuery {
  agentId: AgentId;
  domain: DomainId;
  /** Max items returned. Default 1, max 10. */
  limit?: number;
  /** When false, explanation strings may be omitted. Default true. */
  includeExplanation?: boolean;
}

/**
 * Response payload for the PRIORITY_RESPONSE wire message (wire type 0x41).
 * Returned from the priority engine to the agent that queried.
 */
export interface AgentPriorityResponse {
  items: PrioritizedWorkItem[];
  /** Populated when one or more returned items escalated per §3. */
  pendingReviewReasons?: CompetingContext[];
  /** Budget annotation text if the domain's cap ratio exceeds 0.8. */
  domainBudgetStatus?: string;
  queriedAt: Timestamp;
}

/**
 * A work item decorated with the engine's scoring decision. `priorityScore`
 * is `null` when the item escalated and should not be worked until a
 * steward resolves the competing context.
 */
export interface PrioritizedWorkItem {
  workItem: WorkItem;
  priorityScore: number | null;
  priorityAnnotation?: PriorityAnnotation;
  /** One-line "why" line. Format is non-normative. */
  explanation: string;
}

/**
 * Extension point for implementations that want to learn priority weights
 * from outcomes. The default implementation in
 * `@loom-loyalty/meridian-priority-reference` is a no-op.
 *
 * Non-default implementations produce different priority outputs than the
 * reference, which is expected and allowed — conformance tests only check
 * response shape, not ordering.
 *
 * @experimental May stabilize in v1.1.
 */
export interface PriorityLearner {
  /** Called when the engine commits to a priority score for an item. */
  onDecision(workItemId: WorkItemId, scoreAtSelection: number): void;

  /** Called when a work item completes with a QualitySignal outcome. */
  onOutcome(workItemId: WorkItemId, quality: QualitySignal): void;

  /**
   * Asked periodically for suggested weight adjustments based on outcome
   * data accumulated in the given domain over the given window.
   */
  suggestWeightAdjustment(domain: DomainId, window: Duration): WeightDelta;
}
