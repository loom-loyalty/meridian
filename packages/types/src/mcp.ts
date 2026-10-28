/**
 * MCP binding types.
 *
 * The tool contract a Meridian runtime serves over the Model Context
 * Protocol so that assistants and externally hosted agents can work inside
 * a Meridian system: tool names, permission tiers, inputs, outputs, and
 * errors. See specs/patterns/MCP-SPEC.md.
 *
 * @experimental - all types in this module
 */

import type { ErrorCategory } from "./errors.js";
import type {
  CompetingContextFeedback,
  CostFeedback,
  ErrorFeedback,
  HeartbeatFeedback,
  InsightFeedback,
  MetricFeedback,
} from "./feedback.js";
import type {
  Domain,
  DomainBudget,
  DomainMembership,
  GateConfig,
  Steward,
} from "./domain.js";
import type {
  Attribution,
  ChangeProposalId,
  ChangeProposalStatus,
  KnowledgeNodeId,
  NodeType,
  NodeTypeId,
  NodeTypeMigration,
  ProposalConflict,
  ProposalEvidence,
  ProposalGateConfig,
  ProposalKind,
  RelationType,
  Spec,
  SpecChangeOperation,
  SpecChangeProposal,
  SpecChangeTrigger,
  SpecId,
  SpecImpact,
  SpecImpactEntry,
  SpecRevision,
  SpecRevisionId,
  SpecSection,
  SpecSectionId,
  TaxonomyChangeProposal,
  TaxonomyDefinition,
  TaxonomyId,
  TaxonomyOperation,
} from "./knowledge.js";
import type { PermissionScope } from "./permissions.js";
import type { AgentId, DomainId, Timestamp, WorkItemId } from "./primitives.js";
import type { CompetingContext, EnforcementTier } from "./quality.js";
import type {
  CostEstimate,
  DomainPriorityConfig,
  PrioritizedWorkItem,
  WeightProfile,
  WorkItem,
  WorkItemClaim,
  WorkItemLinkKind,
  WorkItemStatus,
  WorkItemType,
} from "./work-item.js";

// -----------------------------------------------------------------------
// Tiers, tools, identity
// -----------------------------------------------------------------------

/**
 * Permission tier of an MCP token. `propose` includes `read`. Nothing in
 * the binding approves, rejects, or reconfigures (MCP-SPEC.md §4, §6).
 *
 * @experimental
 */
export type McpPermissionTier = "read" | "propose";

/**
 * Tools that require the `read` tier.
 *
 * @experimental
 */
export type McpReadToolName =
  | "meridian_inbox"
  | "meridian_list_work_items"
  | "meridian_get_work_item"
  | "meridian_search"
  | "meridian_get_spec"
  | "meridian_get_taxonomy"
  | "meridian_get_domain"
  | "meridian_get_proposal";

/**
 * Tools that require the `propose` tier.
 *
 * @experimental
 */
export type McpProposeToolName =
  | "meridian_create_work_item"
  | "meridian_transition_work_item"
  | "meridian_claim_work_item"
  | "meridian_renew_claim"
  | "meridian_release_work_item"
  | "meridian_link_artifact"
  | "meridian_declare_impacts"
  | "meridian_propose_spec_change"
  | "meridian_propose_taxonomy_change"
  | "meridian_withdraw_proposal"
  | "meridian_emit_feedback";

/**
 * Every tool name in the binding. The `meridian_` prefix is reserved for
 * these tools (MCP-SPEC.md §5).
 *
 * @experimental
 */
export type McpToolName = McpReadToolName | McpProposeToolName;

/**
 * Where an external agent runs. `kind` is free-form (for example `cli`,
 * `cloud_session`, `chat`).
 *
 * @experimental
 */
export interface ExternalAgentHost {
  kind: string;
  /** Human-readable name of the host or client. */
  label?: string;
  /** Link to the session, when the host has one. */
  sessionUrl?: string;
}

/**
 * An agent the runtime did not spawn, participating only through the MCP
 * binding. Its `agentId` is minted by the runtime at token issue. Like any
 * agent, it can never record a `human_gate` review (MCP-SPEC.md §3).
 *
 * @experimental
 */
export interface ExternalAgent {
  /** Minted at token issue, e.g. `claude-session:<id>`. */
  agentId: AgentId;
  host: ExternalAgentHost;
  /** The human the agent acts for, if any. */
  onBehalfOf?: string;
  /** Declared domain participation (DOMAIN-SPEC.md §4). */
  memberships: DomainMembership[];
  permissions: PermissionScope;
  tier: McpPermissionTier;
  issuedAt: Timestamp;
  expiresAt?: Timestamp;
}

/**
 * The caller as the server resolved it: the attribution its writes carry,
 * its tier, and its role in each visible domain.
 *
 * @experimental
 */
export interface McpPrincipal {
  /** `{ kind: "agent", id, onBehalfOf }`, as recorded on every write. */
  agent: Attribution;
  host?: ExternalAgentHost;
  tier: McpPermissionTier;
  domains: McpPrincipalDomain[];
}

/**
 * The caller's effective role in one domain (MCP-SPEC.md §4.3).
 *
 * @experimental
 */
export interface McpPrincipalDomain {
  domain: DomainId;
  role: DomainMembership["role"];
  /** True when the human the agent acts for is a steward of the domain. */
  humanIsSteward: boolean;
}

// -----------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------

/**
 * Cursor pagination input (MCP-SPEC.md §8).
 *
 * @experimental
 */
export interface McpPageInput {
  /** Opaque cursor from a previous `nextCursor`. */
  cursor?: string;
  /** Default 25, max 100. */
  limit?: number;
}

/**
 * Where and by whom a gated decision is made. Carries no authority: the
 * `url` leads to the implementation's review page, where the human
 * authenticates and decides (MCP-SPEC.md §6).
 *
 * @experimental
 */
export interface McpHumanGateHandoff {
  tier: "human_gate";
  /** What waits: a proposal or a work item transition. */
  subject:
    | { kind: "proposal"; id: ChangeProposalId }
    | { kind: "work_item"; id: WorkItemId; to?: WorkItemStatus };
  /** Domains whose stewards must decide. */
  domains: DomainId[];
  /** Steward ids allowed to approve, when the gate config names them. */
  approvers?: string[];
  url?: string;
}

/**
 * Why a work item cannot proceed. `dependency` is implementation-defined,
 * typically an unfinished item it depends on.
 *
 * @experimental
 */
export interface McpBlockedReason {
  kind:
    | "escalated"
    | "circuit_breaker"
    | "awaiting_human_gate"
    | "dependency"
    | "other";
  detail?: string;
  /** Id of the blocking object, when there is one. */
  ref?: string;
}

/**
 * Totals over a work item and all its non-cancelled descendants.
 * Rolled-up cost of not building is an upper bound, since a parent's
 * estimate may already include its children's.
 *
 * @experimental
 */
export interface McpCostRollup {
  costToBuildUsd: number;
  costOfNotBuildingUsd: number;
  itemCount: number;
  /** Descendants still in `proposed`. */
  unestimatedCount: number;
}

/**
 * A board entry: a `PrioritizedWorkItem` with board-only context.
 * `priorityScore` is `null` when the engine did not score the item; the
 * reason is `priorityAnnotation` or the item's status.
 *
 * @experimental
 */
export interface McpWorkItemEntry extends PrioritizedWorkItem {
  rollup?: McpCostRollup;
  blocked?: McpBlockedReason[];
  /** The unexpired claim, if any. */
  claim?: WorkItemClaim;
}

/**
 * A compact view of a spec or taxonomy change proposal.
 *
 * @experimental
 */
export interface McpProposalSummary {
  id: ChangeProposalId;
  kind: ProposalKind;
  status: ChangeProposalStatus;
  pendingTier?: EnforcementTier;
  /** `specId` for a spec change, `taxonomyId` for a taxonomy change. */
  targetId: SpecId | TaxonomyId;
  rationale: string;
  author: Attribution;
  workItemId?: WorkItemId;
  updatedAt: Timestamp;
}

/**
 * A full proposal with its kind, and the handoff while it waits at the
 * human gate.
 *
 * @experimental
 */
export type McpProposalView = McpSpecProposalView | McpTaxonomyProposalView;

/**
 * A spec change proposal as returned by the binding.
 *
 * @experimental
 */
export interface McpSpecProposalView {
  kind: "spec_change";
  proposal: SpecChangeProposal;
  handoff?: McpHumanGateHandoff;
}

/**
 * A taxonomy change proposal as returned by the binding.
 *
 * @experimental
 */
export interface McpTaxonomyProposalView {
  kind: "taxonomy_change";
  proposal: TaxonomyChangeProposal;
  handoff?: McpHumanGateHandoff;
}

/**
 * Structured tool error, returned with `isError: true`. Mirrors
 * `RuntimeError` (MCP-SPEC.md §7).
 *
 * @experimental
 */
export interface McpToolError {
  category: ErrorCategory;
  message: string;
  retryable: boolean;
  reason?: McpErrorReason;
  context?: Record<string, unknown>;
}

/**
 * Machine-readable refinement of an error category.
 *
 * @experimental
 */
export type McpErrorReason =
  | "tier_required"
  | "not_participant"
  | "lease_held"
  | "not_lease_holder"
  | "escalated"
  | "human_principal_required"
  | "not_author"
  | "invalid_transition"
  | "type_constraint"
  | "deprecated_type"
  | "idempotency_conflict";

// -----------------------------------------------------------------------
// Read tools
// -----------------------------------------------------------------------

/**
 * Kinds of inbox entry (MCP-SPEC.md §5.1).
 *
 * @experimental
 */
export type McpInboxEntryKind = McpInboxEntry["kind"];

/**
 * Fields every inbox entry carries.
 *
 * @experimental
 */
export interface McpInboxEntryBase {
  /** Since when the entry has needed attention. */
  since: Timestamp;
  /** Link to the implementation's UI for this entry. */
  url?: string;
}

/**
 * A proposal waiting at a human gate the calling human may approve.
 *
 * @experimental
 */
export interface McpInboxProposalAwaitingGate extends McpInboxEntryBase {
  kind: "proposal_awaiting_human_gate";
  proposal: McpProposalSummary;
  handoff: McpHumanGateHandoff;
}

/**
 * A work item transition waiting at a human gate the calling human may
 * approve.
 *
 * @experimental
 */
export interface McpInboxWorkItemAwaitingGate extends McpInboxEntryBase {
  kind: "work_item_awaiting_human_gate";
  workItem: WorkItem;
  handoff: McpHumanGateHandoff;
}

/**
 * A blocked work item the calling human stewards.
 *
 * @experimental
 */
export interface McpInboxBlockedWorkItem extends McpInboxEntryBase {
  kind: "blocked_work_item";
  workItem: WorkItem;
  reasons: McpBlockedReason[];
  /** The competing contexts behind an escalation. */
  pendingReviewReasons?: CompetingContext[];
}

/**
 * A conflicted proposal authored by the calling human or on their behalf.
 *
 * @experimental
 */
export interface McpInboxProposalConflicted extends McpInboxEntryBase {
  kind: "proposal_conflicted";
  proposal: McpProposalSummary;
  conflicts: ProposalConflict[];
}

/**
 * A domain the calling human stewards has crossed its alert threshold.
 *
 * @experimental
 */
export interface McpInboxBudgetAlert extends McpInboxEntryBase {
  kind: "budget_alert";
  domain: DomainId;
  budget: DomainBudget;
  /** `currentSpendUsd / monthlyLimitUsd`. */
  ratio: number;
}

/**
 * An entry in the calling human's inbox.
 *
 * @experimental
 */
export type McpInboxEntry =
  | McpInboxProposalAwaitingGate
  | McpInboxWorkItemAwaitingGate
  | McpInboxBlockedWorkItem
  | McpInboxProposalConflicted
  | McpInboxBudgetAlert;

/**
 * Input of `meridian_inbox`.
 *
 * @experimental
 */
export interface McpInboxInput extends McpPageInput {
  kinds?: McpInboxEntryKind[];
  domain?: DomainId;
}

/**
 * Output of `meridian_inbox`.
 *
 * @experimental
 */
export interface McpInboxOutput {
  principal: McpPrincipal;
  entries: McpInboxEntry[];
  nextCursor?: string;
}

/**
 * Sort keys for the board. `cost_of_delay` is `costOfNotBuilding`;
 * `net_value` is `costOfNotBuilding − costToBuild`.
 *
 * @experimental
 */
export type McpWorkItemSort =
  | "priority"
  | "cost_of_delay"
  | "cost_to_build"
  | "net_value";

/**
 * Input of `meridian_list_work_items`.
 *
 * @experimental
 */
export interface McpListWorkItemsInput extends McpPageInput {
  domain?: DomainId;
  /** Items in this node's containment subtree (MCP-SPEC.md §5.1). */
  scopeNodeId?: KnowledgeNodeId;
  typeIds?: NodeTypeId[];
  types?: WorkItemType[];
  /** 0-based rung on the resolved ladder. */
  ladderRung?: number;
  /** Default: every status except `done` and `cancelled`. */
  statuses?: WorkItemStatus[];
  blocked?: boolean;
  claimed?: boolean;
  /** Default `priority`. */
  sort?: McpWorkItemSort;
  /** Default depends on `sort` (MCP-SPEC.md §5.1). */
  order?: "asc" | "desc";
  /** Default `own`. */
  costBasis?: "own" | "rollup";
  /** As in `AgentPriorityQuery`. Default true. */
  includeExplanation?: boolean;
}

/**
 * Output of `meridian_list_work_items`. Mirrors `AgentPriorityResponse`.
 *
 * @experimental
 */
export interface McpListWorkItemsOutput {
  items: McpWorkItemEntry[];
  pendingReviewReasons?: CompetingContext[];
  domainBudgetStatus?: string;
  queriedAt: Timestamp;
  nextCursor?: string;
}

/**
 * Input of `meridian_get_work_item`.
 *
 * @experimental
 */
export interface McpGetWorkItemInput {
  workItemId: WorkItemId;
  includeExplanation?: boolean;
}

/**
 * A spec related to a work item, and why.
 *
 * @experimental
 */
export interface McpRelatedSpec {
  spec: Spec;
  reason: "declared_impact" | "inferred_impact" | "attached";
  sectionIds?: SpecSectionId[];
}

/**
 * Actual cost reported against a work item (MCP-SPEC.md §5.3).
 *
 * @experimental
 */
export interface McpActualCost {
  amountUsd: number;
  byDomain: Record<DomainId, number>;
}

/**
 * Output of `meridian_get_work_item`: the item and its context bundle.
 *
 * @experimental
 */
export interface McpWorkItemContext {
  item: McpWorkItemEntry;
  /** `parentId` chain, root first. */
  ancestors: WorkItem[];
  childCount: number;
  childStatusCounts: Partial<Record<WorkItemStatus, number>>;
  inferredImpact?: SpecImpactEntry[];
  relatedSpecs: McpRelatedSpec[];
  proposals: McpProposalSummary[];
  actualCost?: McpActualCost;
  handoff?: McpHumanGateHandoff;
}

/**
 * Kinds of object `meridian_search` can return.
 *
 * @experimental
 */
export type McpSearchKind =
  | "work_item"
  | "node"
  | "spec"
  | "section"
  | "proposal";

/**
 * Input of `meridian_search`.
 *
 * @experimental
 */
export interface McpSearchInput extends McpPageInput {
  query: string;
  kinds?: McpSearchKind[];
  domain?: DomainId;
}

/**
 * One search result. Ranking is implementation-defined.
 *
 * @experimental
 */
export interface McpSearchHit {
  kind: McpSearchKind;
  id: string;
  title: string;
  snippet?: string;
  domain?: DomainId;
  /** For `section` hits. */
  specId?: SpecId;
  score?: number;
}

/**
 * Output of `meridian_search`.
 *
 * @experimental
 */
export interface McpSearchOutput {
  hits: McpSearchHit[];
  nextCursor?: string;
}

/**
 * Input of `meridian_get_spec`.
 *
 * @experimental
 */
export interface McpGetSpecInput {
  specId: SpecId;
  /** Default: head. */
  revisionId?: SpecRevisionId;
  /** Default: all. A listed section brings its descendants. */
  sectionIds?: SpecSectionId[];
}

/**
 * Output of `meridian_get_spec`.
 *
 * @experimental
 */
export interface McpGetSpecOutput {
  spec: Spec;
  revision: Omit<SpecRevision, "sections">;
  /** Selected sections, in document order. */
  sections: SpecSection[];
  isHead: boolean;
  openProposalIds: ChangeProposalId[];
}

/**
 * Input of `meridian_get_taxonomy`.
 *
 * @experimental
 */
export interface McpGetTaxonomyInput {
  /** Default: current. */
  version?: number;
  domain?: DomainId;
}

/**
 * The taxonomy as one domain sees it (KNOWLEDGE-SPEC.md §3, §6).
 *
 * @experimental
 */
export interface McpResolvedTaxonomy {
  domain: DomainId;
  ladder: NodeTypeId[];
  ladderSource: "domain" | "default";
  ownedNodeTypes: NodeType[];
  sharedNodeTypes: NodeType[];
  ownedRelationTypes: RelationType[];
  sharedRelationTypes: RelationType[];
}

/**
 * Output of `meridian_get_taxonomy`.
 *
 * @experimental
 */
export interface McpGetTaxonomyOutput {
  taxonomy: TaxonomyDefinition;
  resolved?: McpResolvedTaxonomy;
}

/**
 * Input of `meridian_get_domain`.
 *
 * @experimental
 */
export interface McpGetDomainInput {
  domain: DomainId;
}

/**
 * Output of `meridian_get_domain`.
 *
 * @experimental
 */
export interface McpDomainView {
  id: DomainId;
  name: string;
  description?: Domain["description"];
  /** `email` MAY be omitted. */
  stewards: Steward[];
  budget?: DomainBudget;
  gates: GateConfig[];
  proposalGates: ProposalGateConfig[];
  priorityConfig?: DomainPriorityConfig;
  /** The resolved weight profile. */
  weightProfile?: WeightProfile;
  role: DomainMembership["role"];
}

/**
 * Input of `meridian_get_proposal` and the target of
 * `meridian_withdraw_proposal`.
 *
 * @experimental
 */
export interface McpGetProposalInput {
  proposalId: ChangeProposalId;
}

// -----------------------------------------------------------------------
// Propose tools
// -----------------------------------------------------------------------

/**
 * A spec impact entry as submitted. `source` defaults to `declared`.
 *
 * @experimental
 */
export interface McpImpactEntryInput extends Omit<SpecImpactEntry, "source"> {
  source?: SpecImpactEntry["source"];
}

/**
 * Input of `meridian_create_work_item`. The item starts in `proposed`.
 *
 * @experimental
 */
export interface McpCreateWorkItemInput {
  title: string;
  description?: string;
  domains: DomainId[];
  /** One of `type` and `typeId` is required. */
  type?: WorkItemType;
  typeId?: NodeTypeId;
  parentId?: WorkItemId;
  lineage?: WorkItemId;
  costOfNotBuilding: CostEstimate;
  /** Default: unestimated (WORK-ITEM-SPEC.md §6). */
  costToBuild?: CostEstimate;
  confidence: number;
  specImpact?: McpImpactEntryInput[];
  idempotencyKey?: string;
}

/**
 * Output of tools that return one work item.
 *
 * @experimental
 */
export interface McpWorkItemOutput {
  workItem: WorkItem;
}

/**
 * Input of `meridian_transition_work_item`.
 *
 * @experimental
 */
export interface McpTransitionWorkItemInput {
  workItemId: WorkItemId;
  to: WorkItemStatus;
  note: string;
  /** Revised estimates, e.g. for `researching → ready`. */
  estimates?: {
    costToBuild?: CostEstimate;
    costOfNotBuilding?: CostEstimate;
    confidence?: number;
  };
}

/**
 * Output of `meridian_transition_work_item`. `pending` means the
 * transition is gated and the status has not changed.
 *
 * @experimental
 */
export interface McpTransitionOutput {
  outcome: "applied" | "pending";
  workItem: WorkItem;
  pendingTier?: EnforcementTier;
  handoff?: McpHumanGateHandoff;
}

/**
 * Input of `meridian_claim_work_item`.
 *
 * @experimental
 */
export interface McpClaimWorkItemInput {
  workItemId: WorkItemId;
  /** Requested lease. Default 900; servers MAY clamp. */
  leaseSeconds?: number;
  note?: string;
}

/**
 * Input of `meridian_renew_claim`.
 *
 * @experimental
 */
export interface McpRenewClaimInput {
  workItemId: WorkItemId;
  leaseSeconds?: number;
}

/**
 * Output of `meridian_claim_work_item` and `meridian_renew_claim`.
 *
 * @experimental
 */
export interface McpClaimOutput {
  claim: WorkItemClaim;
}

/**
 * Input of `meridian_release_work_item`.
 *
 * @experimental
 */
export interface McpReleaseWorkItemInput {
  workItemId: WorkItemId;
  note?: string;
}

/**
 * Input of `meridian_link_artifact`. `addedBy` and `addedAt` are set by
 * the server.
 *
 * @experimental
 */
export interface McpLinkArtifactInput {
  workItemId: WorkItemId;
  link: { kind: WorkItemLinkKind; url: string; title?: string };
}

/**
 * Input of `meridian_declare_impacts`.
 *
 * @experimental
 */
export interface McpDeclareImpactsInput {
  workItemId: WorkItemId;
  entries: McpImpactEntryInput[];
  /** `merge` (default) replaces entries per `specId`; `replace` replaces all. */
  mode?: "merge" | "replace";
}

/**
 * Output of `meridian_declare_impacts`.
 *
 * @experimental
 */
export interface McpDeclareImpactsOutput {
  specImpact: SpecImpact;
}

/**
 * Input of `meridian_propose_spec_change`.
 *
 * @experimental
 */
export interface McpProposeSpecChangeInput {
  specId: SpecId;
  baseRevisionId: SpecRevisionId;
  operations: SpecChangeOperation[];
  rationale: string;
  evidence?: ProposalEvidence[];
  workItemId?: WorkItemId;
  /** Default `manual`. */
  trigger?: SpecChangeTrigger;
  supersedes?: ChangeProposalId;
  /** Default true: enter `in_review`. False leaves a `draft`. */
  submit?: boolean;
  idempotencyKey?: string;
}

/**
 * Input of `meridian_propose_taxonomy_change`.
 *
 * @experimental
 */
export interface McpProposeTaxonomyChangeInput {
  taxonomyId: TaxonomyId;
  baseVersion: number;
  operations: TaxonomyOperation[];
  migrations?: NodeTypeMigration[];
  rationale: string;
  supersedes?: ChangeProposalId;
  submit?: boolean;
  idempotencyKey?: string;
}

/**
 * Input of `meridian_withdraw_proposal`.
 *
 * @experimental
 */
export interface McpWithdrawProposalInput {
  proposalId: ChangeProposalId;
  reason: string;
}

/**
 * Feedback signal types the binding accepts.
 *
 * @experimental
 */
export type McpEmittableFeedback =
  | HeartbeatFeedback
  | CostFeedback
  | ErrorFeedback
  | MetricFeedback
  | InsightFeedback
  | CompetingContextFeedback;

/**
 * An emittable signal without the fields the server sets. A supplied
 * `agentId` that is not the caller's is rejected.
 *
 * @experimental
 */
export type McpFeedbackSignalInput = WithoutServerFields<McpEmittableFeedback>;

/**
 * Distributes over a signal union, making `agentId` and `timestamp`
 * optional on each member.
 */
type WithoutServerFields<T> = T extends unknown
  ? Omit<T, "agentId" | "timestamp"> & {
      agentId?: AgentId;
      timestamp?: Timestamp;
    }
  : never;

/**
 * Input of `meridian_emit_feedback`.
 *
 * @experimental
 */
export interface McpEmitFeedbackInput {
  signal: McpFeedbackSignalInput;
  /** Correlates the signal with a work item; for heartbeats, the claim to renew. */
  workItemId?: WorkItemId;
  idempotencyKey?: string;
}

/**
 * Output of `meridian_emit_feedback`.
 *
 * @experimental
 */
export interface McpEmitFeedbackOutput {
  receivedAt: Timestamp;
  /** Claims a heartbeat renewed. */
  renewedClaims?: WorkItemClaim[];
  /** A work item the signal created or joined, if known at return time. */
  correlatedWorkItemId?: WorkItemId;
}

/**
 * Output of the proposal-creating tools.
 *
 * @experimental
 */
export interface McpProposeOutput<P> {
  proposal: P;
  handoff?: McpHumanGateHandoff;
}

// -----------------------------------------------------------------------
// Tool maps
// -----------------------------------------------------------------------

/**
 * Input shape of each tool.
 *
 * @experimental
 */
export interface McpToolInputs {
  meridian_inbox: McpInboxInput;
  meridian_list_work_items: McpListWorkItemsInput;
  meridian_get_work_item: McpGetWorkItemInput;
  meridian_search: McpSearchInput;
  meridian_get_spec: McpGetSpecInput;
  meridian_get_taxonomy: McpGetTaxonomyInput;
  meridian_get_domain: McpGetDomainInput;
  meridian_get_proposal: McpGetProposalInput;
  meridian_create_work_item: McpCreateWorkItemInput;
  meridian_transition_work_item: McpTransitionWorkItemInput;
  meridian_claim_work_item: McpClaimWorkItemInput;
  meridian_renew_claim: McpRenewClaimInput;
  meridian_release_work_item: McpReleaseWorkItemInput;
  meridian_link_artifact: McpLinkArtifactInput;
  meridian_declare_impacts: McpDeclareImpactsInput;
  meridian_propose_spec_change: McpProposeSpecChangeInput;
  meridian_propose_taxonomy_change: McpProposeTaxonomyChangeInput;
  meridian_withdraw_proposal: McpWithdrawProposalInput;
  meridian_emit_feedback: McpEmitFeedbackInput;
}

/**
 * Output shape of each tool, returned as `structuredContent`.
 *
 * @experimental
 */
export interface McpToolOutputs {
  meridian_inbox: McpInboxOutput;
  meridian_list_work_items: McpListWorkItemsOutput;
  meridian_get_work_item: McpWorkItemContext;
  meridian_search: McpSearchOutput;
  meridian_get_spec: McpGetSpecOutput;
  meridian_get_taxonomy: McpGetTaxonomyOutput;
  meridian_get_domain: McpDomainView;
  meridian_get_proposal: McpProposalView;
  meridian_create_work_item: McpWorkItemOutput;
  meridian_transition_work_item: McpTransitionOutput;
  meridian_claim_work_item: McpClaimOutput;
  meridian_renew_claim: McpClaimOutput;
  meridian_release_work_item: McpWorkItemOutput;
  meridian_link_artifact: McpWorkItemOutput;
  meridian_declare_impacts: McpDeclareImpactsOutput;
  meridian_propose_spec_change: McpProposeOutput<SpecChangeProposal>;
  meridian_propose_taxonomy_change: McpProposeOutput<TaxonomyChangeProposal>;
  meridian_withdraw_proposal: McpProposalView;
  meridian_emit_feedback: McpEmitFeedbackOutput;
}

/**
 * Required tier of each tool (MCP-SPEC.md §5).
 *
 * @experimental
 */
export type McpToolTier<N extends McpToolName> = N extends McpReadToolName
  ? "read"
  : "propose";

/**
 * Error payload of a failed tool call, as `structuredContent`.
 *
 * @experimental
 */
export interface McpToolErrorResult {
  error: McpToolError;
}
