/**
 * Business knowledge model types.
 *
 * A tenant-defined, versioned taxonomy (node types + relation types), a
 * typed knowledge graph of nodes and relations, living specs with
 * immutable revisions, and the proposal flow that turns completed work
 * into spec changes. See specs/patterns/KNOWLEDGE-SPEC.md.
 *
 * @experimental - all types in this module
 */

import type { AgentId, DomainId, Timestamp, WorkItemId } from "./primitives.js";
import type { EnforcementTier, QualitySignal } from "./quality.js";
import type { WorkItemType } from "./work-item.js";

// -----------------------------------------------------------------------
// Identifiers
// -----------------------------------------------------------------------

/**
 * Identifier for a taxonomy. Unique within a tenant.
 *
 * @experimental
 */
export type TaxonomyId = string;

/**
 * Identifier for a node type (e.g. `"capability"`, `"epic"`). Unique within
 * a taxonomy. Tenant data, never a protocol enum.
 *
 * @experimental
 */
export type NodeTypeId = string;

/**
 * Identifier for a relation type (e.g. `"realizes"`, `"depends-on"`).
 * Unique within a taxonomy.
 *
 * @experimental
 */
export type RelationTypeId = string;

/**
 * Identifier for a knowledge node. For delivery-type nodes this is the same
 * value as the corresponding `WorkItemId`. See KNOWLEDGE-SPEC.md §6.
 *
 * @experimental
 */
export type KnowledgeNodeId = string;

/**
 * Identifier for a relation (edge) between two knowledge nodes.
 *
 * @experimental
 */
export type RelationId = string;

/**
 * Identifier for a living spec document.
 *
 * @experimental
 */
export type SpecId = string;

/**
 * Stable identifier for a section within a spec. Survives heading edits,
 * reordering, and revisions; never reused after removal.
 *
 * @experimental
 */
export type SpecSectionId = string;

/**
 * Identifier for an immutable spec revision.
 *
 * @experimental
 */
export type SpecRevisionId = string;

/**
 * Identifier for a spec or taxonomy change proposal.
 *
 * @experimental
 */
export type ChangeProposalId = string;

// -----------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------

/**
 * Who made a change. Every revision, proposal, and review is attributed.
 * `kind: "agent"` actors MUST NOT appear as the reviewer of a
 * `human_gate` review (KNOWLEDGE-SPEC.md §11).
 *
 * @experimental
 */
export interface Attribution {
  kind: "human" | "agent" | "system";
  /** Steward id, human user id, `AgentId`, or a system component name. */
  id: string;
  /** For agents: the human or domain the agent acted on behalf of, if any. */
  onBehalfOf?: string;
  /** For agents backed by a model: which model did the work, and why that one. */
  model?: ModelAttribution;
}

/**
 * The model behind an agent's action and how it was chosen. See
 * KNOWLEDGE-SPEC.md §8.2 ("Provenance").
 *
 * @experimental
 */
export interface ModelAttribution {
  /** Implementation-defined model id (for example a provider's model name). */
  model: string;
  /**
   * `default`: the agent's configured model. `pinned`: an operator override.
   * `routed`: chosen per call by `router` among the agent's candidates.
   */
  choice?: "default" | "pinned" | "routed";
  /** For `routed`: the model or agent that chose. */
  router?: string;
  /** For `routed`: the router's probability for its pick, in [0, 1]. */
  probability?: number;
}

/**
 * Lifecycle of a taxonomy entry (node type or relation type).
 * `deprecated` entries stay valid for existing data but accept no new
 * nodes or relations; `retired` entries have no live data left.
 *
 * @experimental
 */
export type TaxonomyEntryStatus = "active" | "deprecated" | "retired";

/**
 * JSON-Schema-like field schema for a node type. Implementations choose
 * the dialect; the protocol only requires that `fields` on a node can be
 * validated against it. Unknown keywords are permitted.
 *
 * @experimental
 */
export interface FieldSchema {
  type?: string;
  properties?: Record<string, FieldSchema>;
  required?: string[];
  description?: string;
  [keyword: string]: unknown;
}

// -----------------------------------------------------------------------
// Taxonomy
// -----------------------------------------------------------------------

/**
 * A tenant-defined kind of knowledge node, e.g. business domain,
 * capability, application, epic. See KNOWLEDGE-SPEC.md §3.
 *
 * @experimental
 */
export interface NodeType {
  id: NodeTypeId;
  label: string;
  description?: string;
  /** Schema that `KnowledgeNode.fields` is validated against. */
  fieldSchema?: FieldSchema;
  /**
   * Types allowed as this type's containment parent (`KnowledgeNode.parentId`).
   * Omitted: any type may be the parent. Empty array: nodes of this type
   * are always roots.
   */
  allowedParentTypes?: NodeTypeId[];
  /** When true, every node of this type MUST have a parent. Default false. */
  parentRequired?: boolean;
  /** Relation types nodes of this type may participate in. Omitted: any. */
  allowedRelations?: RelationTypeId[];
  /** Free-form grouping, e.g. `"business"`, `"architecture"`, `"delivery"`. */
  category?: string;
  /**
   * For delivery types: the nearest built-in `WorkItemType`. Lets gates and
   * priority engines written against `WorkItemType` handle tenant-defined
   * rungs (e.g. a `"feature"` type that maps to `"story"`).
   */
  workItemType?: WorkItemType;
  /**
   * Domain that owns this type: its stewards gate changes to it
   * (KNOWLEDGE-SPEC.md §3.5). Omitted: a shared core type, owned by the
   * taxonomy's own `TaxonomyDefinition.domain`. Ownership of the type is
   * separate from ownership of nodes of the type (`KnowledgeNode.domain`).
   *
   * @experimental
   */
  domain?: DomainId;
  status: TaxonomyEntryStatus;
  /** Replacement type for a deprecated type, if any. */
  supersededBy?: NodeTypeId;
  /** Taxonomy version that introduced this type. */
  introducedIn: number;
  /** Taxonomy version that deprecated this type, if any. */
  deprecatedIn?: number;
}

/**
 * Cardinality of a relation type, read as from-side to to-side.
 *
 * @experimental
 */
export type RelationCardinality =
  | "one_to_one"
  | "one_to_many"
  | "many_to_one"
  | "many_to_many";

/**
 * A tenant-defined kind of directed edge between nodes, e.g. `realizes`,
 * `depends-on`, `implements`, `supersedes`. See KNOWLEDGE-SPEC.md §3.
 *
 * @experimental
 */
export interface RelationType {
  id: RelationTypeId;
  label: string;
  /** Label read in the to → from direction, e.g. `"realized by"`. */
  inverseLabel?: string;
  description?: string;
  /** Allowed source node types. Omitted: any. */
  fromTypes?: NodeTypeId[];
  /** Allowed target node types. Omitted: any. */
  toTypes?: NodeTypeId[];
  cardinality: RelationCardinality;
  /**
   * Whether spec-impact inference traverses this edge, and in which
   * direction. Omitted: not traversed. See KNOWLEDGE-SPEC.md §7.2.
   */
  impactPropagation?: "forward" | "reverse" | "both";
  /** Multiplier (0.0 to 1.0) applied to confidence when traversing. */
  impactWeight?: number;
  /**
   * Domain that owns this relation type: its stewards gate changes to it
   * (KNOWLEDGE-SPEC.md §3.5). Omitted: a shared core type, owned by the
   * taxonomy's own `TaxonomyDefinition.domain`.
   *
   * @experimental
   */
  domain?: DomainId;
  status: TaxonomyEntryStatus;
  supersededBy?: RelationTypeId;
  introducedIn: number;
  deprecatedIn?: number;
}

/**
 * How existing nodes of one type are carried into a new taxonomy version
 * when that type changes. See KNOWLEDGE-SPEC.md §3.3.
 *
 * @experimental
 */
export interface NodeTypeMigration {
  fromTypeId: NodeTypeId;
  /** Same as `fromTypeId` for an in-place schema change. */
  toTypeId: NodeTypeId;
  /** Old field name → new field name; `null` drops the field. */
  fieldMap?: Record<string, string | null>;
  /** Values for fields that are newly required. */
  defaults?: Record<string, unknown>;
  /**
   * Per field (by its new name), old value → new value, applied after
   * `fieldMap`. Keys are the old values as strings. Use it when an enum
   * narrows or a value is renamed; a node whose value has no mapping and
   * no longer validates fails the migration's dry run.
   */
  valueMap?: Record<string, Record<string, unknown>>;
  /**
   * `eager`: all nodes are rewritten when the version is published.
   * `lazy`: nodes are migrated on next write; reads see them at their
   * recorded `taxonomyVersion` until then.
   */
  mode: "eager" | "lazy";
}

/**
 * A delivery ladder that one domain uses in place of the taxonomy's
 * default `deliveryLadder`. See KNOWLEDGE-SPEC.md §6.
 *
 * @experimental
 */
export interface DomainDeliveryLadder {
  /** The domain this ladder applies to. Its stewards gate changes to it. */
  domain: DomainId;
  /**
   * Ordered from top to bottom. Each entry is a `NodeTypeId` in the
   * taxonomy's `nodeTypes`, and SHOULD be a shared type or one owned by
   * `domain`.
   */
  ladder: NodeTypeId[];
}

/**
 * A versioned, tenant-owned taxonomy. Data, not code: the protocol never
 * depends on a particular node or relation type existing.
 *
 * @experimental
 */
export interface TaxonomyDefinition {
  id: TaxonomyId;
  tenantId?: string;
  /** Monotonic, starting at 1. Each published change increments it. */
  version: number;
  label: string;
  /**
   * Domain whose stewards gate changes to shared types (those without
   * their own `domain`) and to the default `deliveryLadder`.
   */
  domain: DomainId;
  nodeTypes: NodeType[];
  relationTypes: RelationType[];
  /**
   * Default delivery ladder, ordered from top (e.g. `"program"`) to bottom
   * (e.g. `"task"`). Each entry is a `NodeTypeId` in `nodeTypes`. Used by
   * every domain without an entry in `domainLadders`.
   */
  deliveryLadder?: NodeTypeId[];
  /**
   * Per-domain delivery ladders, at most one per domain. A domain listed
   * here uses its own ladder instead of `deliveryLadder`.
   *
   * @experimental
   */
  domainLadders?: DomainDeliveryLadder[];
  /** Migrations applied when moving from `version - 1` to this version. */
  migrations?: NodeTypeMigration[];
  /** Proposal that produced this version. Absent for the initial seed. */
  proposalId?: ChangeProposalId;
  publishedAt: Timestamp;
}

// -----------------------------------------------------------------------
// Graph
// -----------------------------------------------------------------------

/**
 * Lifecycle of a knowledge node, spec, or relation.
 *
 * @experimental
 */
export type KnowledgeStatus = "draft" | "active" | "deprecated" | "archived";

/**
 * A typed node in the knowledge graph. See KNOWLEDGE-SPEC.md §4.
 *
 * @experimental
 */
export interface KnowledgeNode {
  id: KnowledgeNodeId;
  tenantId?: string;
  typeId: NodeTypeId;
  /** Taxonomy version `fields` were last validated against. */
  taxonomyVersion: number;
  title: string;
  summary?: string;
  /** Values validated against the node type's `fieldSchema`. */
  fields: Record<string, unknown>;
  /** Owning domain: accountability, per DOMAIN-SPEC.md. */
  domain: DomainId;
  /** `Steward.id` values responsible for this node. */
  stewards: string[];
  /** Optional containment parent. Other structure lives in relations. */
  parentId?: KnowledgeNodeId;
  status: KnowledgeStatus;
  createdBy: Attribution;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A typed, directed edge between two nodes. See KNOWLEDGE-SPEC.md §4.2.
 *
 * @experimental
 */
export interface Relation {
  id: RelationId;
  tenantId?: string;
  typeId: RelationTypeId;
  from: KnowledgeNodeId;
  to: KnowledgeNodeId;
  /** Optional edge attributes, e.g. a coverage percentage. */
  fields?: Record<string, unknown>;
  status: KnowledgeStatus;
  createdBy: Attribution;
  createdAt: Timestamp;
}

// -----------------------------------------------------------------------
// Specs and revisions
// -----------------------------------------------------------------------

/**
 * A living document attached to a knowledge node. Content lives in
 * immutable revisions; `headRevisionId` names the current one.
 *
 * @experimental
 */
export interface Spec {
  id: SpecId;
  tenantId?: string;
  nodeId: KnowledgeNodeId;
  title: string;
  /** Owning domain. Defaults to the attached node's domain. */
  domain: DomainId;
  /** Media type of section bodies, e.g. `"text/markdown"`. */
  format: string;
  headRevisionId: SpecRevisionId;
  status: KnowledgeStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * A typed cross-reference from a spec section to a node, spec, or section.
 *
 * @experimental
 */
export interface SpecLink {
  relationTypeId: RelationTypeId;
  targetNodeId: KnowledgeNodeId;
  targetSpecId?: SpecId;
  targetSectionId?: SpecSectionId;
}

/**
 * An addressable section of a spec, as captured in one revision.
 *
 * @experimental
 */
export interface SpecSection {
  id: SpecSectionId;
  heading: string;
  body: string;
  /** For nested sections. Absent for top-level sections. */
  parentSectionId?: SpecSectionId;
  links?: SpecLink[];
  /** Hash of heading + body + links; used for rebase checks. */
  contentHash?: string;
  /**
   * Domain that owns this section when it differs from the spec's.
   * Inherited from the parent section, then the spec, when absent.
   * Decides who gates changes to the section (KNOWLEDGE-SPEC.md §5.1).
   */
  owningDomain?: DomainId;
}

/**
 * Why a revision exists. At least one of `workItemId` or `proposalId` is
 * present on every revision except a spec's first.
 *
 * @experimental
 */
export interface RevisionCause {
  workItemId?: WorkItemId;
  proposalId?: ChangeProposalId;
}

/**
 * An immutable snapshot of a spec. Never edited after creation.
 *
 * @experimental
 */
export interface SpecRevision {
  id: SpecRevisionId;
  specId: SpecId;
  /** Monotonic per spec, starting at 1. */
  number: number;
  parentRevisionId?: SpecRevisionId;
  /** Sections in document order. */
  sections: SpecSection[];
  author: Attribution;
  createdAt: Timestamp;
  cause: RevisionCause;
}

// -----------------------------------------------------------------------
// Spec impact
// -----------------------------------------------------------------------

/**
 * What a work item expects to do to a spec. `verify` means the spec is
 * expected to be checked but probably not changed.
 *
 * @experimental
 */
export type SpecImpactIntent = "add" | "change" | "remove" | "verify";

/**
 * One hop of the graph traversal that led to an inferred impact.
 *
 * @experimental
 */
export interface ImpactPathStep {
  relationTypeId: RelationTypeId;
  from: KnowledgeNodeId;
  to: KnowledgeNodeId;
}

/**
 * A spec (and optionally specific sections) a work item is expected to
 * change. See KNOWLEDGE-SPEC.md §7.
 *
 * @experimental
 */
export interface SpecImpactEntry {
  specId: SpecId;
  /** Omitted: the whole spec, or a new section for `intent: "add"`. */
  sectionIds?: SpecSectionId[];
  intent: SpecImpactIntent;
  /** `declared` by a human or agent, or `inferred` from the graph. */
  source: "declared" | "inferred";
  /** 0.0 to 1.0. Declared entries conventionally use 1.0. */
  confidence: number;
  /** For inferred entries: the traversal that produced this entry. */
  path?: ImpactPathStep[];
  rationale?: string;
}

/**
 * The full set of expected spec changes declared on a work item.
 *
 * @experimental
 */
export interface SpecImpact {
  workItemId: WorkItemId;
  entries: SpecImpactEntry[];
  declaredBy: Attribution;
  declaredAt: Timestamp;
}

// -----------------------------------------------------------------------
// Change proposals
// -----------------------------------------------------------------------

/**
 * Lifecycle of a spec or taxonomy change proposal. See KNOWLEDGE-SPEC.md §8.3.
 *
 * @experimental
 */
export type ChangeProposalStatus =
  | "draft"
  | "in_review"
  | "conflicted"
  | "accepted"
  | "rejected"
  | "withdrawn"
  | "superseded";

/**
 * Add a new section. `section.id` MUST NOT collide with any section id the
 * spec has ever used.
 *
 * @experimental
 */
export interface AddSectionOperation {
  op: "add_section";
  section: SpecSection;
  /** Insert after this section. Omitted: append at the end of the parent. */
  afterSectionId?: SpecSectionId;
}

/**
 * Replace a section's heading and/or body.
 *
 * @experimental
 */
export interface ReplaceSectionOperation {
  op: "replace_section";
  sectionId: SpecSectionId;
  heading?: string;
  body: string;
  /** `contentHash` of the section at the base revision. */
  baseContentHash?: string;
}

/**
 * Remove a section. Its id is retired, not reused.
 *
 * @experimental
 */
export interface RemoveSectionOperation {
  op: "remove_section";
  sectionId: SpecSectionId;
  baseContentHash?: string;
}

/**
 * Move a section, keeping its id, content, and links. A move changes only
 * the section's position, so rebase checks treat it like a change to the
 * section and to its new anchor.
 *
 * @experimental
 */
export interface MoveSectionOperation {
  op: "move_section";
  sectionId: SpecSectionId;
  /**
   * Place it after this sibling. `null`: first under its parent.
   * Omitted: last under its parent.
   */
  afterSectionId?: SpecSectionId | null;
  /** New parent. `null`: make it top-level. Omitted: keep the current parent. */
  parentSectionId?: SpecSectionId | null;
  /** `contentHash` of the section at the base revision. */
  baseContentHash?: string;
}

/**
 * Add or remove typed links on a section.
 *
 * @experimental
 */
export interface RelinkOperation {
  op: "relink";
  sectionId: SpecSectionId;
  add?: SpecLink[];
  remove?: SpecLink[];
}

/**
 * A section-level operation inside a `SpecChangeProposal`.
 *
 * @experimental
 */
export type SpecChangeOperation =
  | AddSectionOperation
  | ReplaceSectionOperation
  | RemoveSectionOperation
  | MoveSectionOperation
  | RelinkOperation;

/**
 * Supporting material for a proposal: a commit, a test run, a feedback
 * signal, a document. `ref` is implementation-defined (URI recommended).
 *
 * @experimental
 */
export interface ProposalEvidence {
  kind: "commit" | "test_result" | "feedback" | "document" | "custom";
  ref: string;
  summary?: string;
}

/**
 * One enforcement-tier decision on a proposal, with its reviewer.
 *
 * @experimental
 */
export interface ProposalReview {
  tier: EnforcementTier;
  signal: QualitySignal;
  /** Who decided: for a `decided` review, the decision agent, not the reviewer it stood in for. */
  reviewer: Attribution;
  decidedAt: Timestamp;
  /** How the review was reached. Absent means `written`. */
  basis?: ReviewBasis;
}

/**
 * How an agent-review outcome was reached (KNOWLEDGE-SPEC.md §8.2,
 * "Provenance").
 *
 * - `written`: the reviewer examined the change and wrote the signal.
 * - `decided`: a decision model predicted the reviewer's verdict with a
 *   calibrated probability, and no written review was produced. A decided
 *   review MUST NOT be the only agent review before a proposal is applied
 *   without a human gate.
 *
 * @experimental
 */
export interface ReviewBasis {
  kind: "written" | "decided";
  /** For `decided`: the reviewer (`AgentId`) whose review this stands in for. */
  standsInFor?: string;
  /** For `decided`: the probability of the recorded result, in [0, 1]. */
  probability?: number;
}

/**
 * An assessment of how much harm a proposal could do if it were wrong and
 * applied unchecked, on ordered levels (KNOWLEDGE-SPEC.md §8.2, "Risk").
 *
 * @experimental
 */
export interface ProposalRisk {
  /** Level descriptions, lowest first. */
  levels: string[];
  /** Probability per level, same order; sums to 1. */
  probabilities: number[];
  /** Probability-weighted level index (0 = the lowest level). */
  score: number;
  /**
   * True when the assessment added a human gate the proposal's domains
   * would not otherwise require.
   */
  escalated: boolean;
  assessedBy: Attribution;
  assessedAt: Timestamp;
}

/**
 * A question settled while a proposal was drafted (for example in a
 * shared chat beside a multiplayer draft), recorded apart from the prose
 * it shaped so a later rewrite cannot silently change what was decided.
 * See KNOWLEDGE-SPEC.md §8.4.
 *
 * @experimental
 */
export interface ProposalDecision {
  /** Unique within the proposal. */
  id: string;
  question: string;
  answer: string;
  decidedBy: Attribution;
  decidedAt: Timestamp;
  /** Sections the decision shaped, when known. */
  sectionIds?: SpecSectionId[];
}

/**
 * Which kind of proposal a `ProposalGateConfig` applies to.
 *
 * @experimental
 */
export type ProposalKind = "spec_change" | "taxonomy_change";

/**
 * A domain's gate configuration for knowledge change proposals, held in
 * `Domain.proposalGates`. The mechanical tier always runs, and taxonomy
 * proposals always include `human_gate`, whatever `enforcement` says.
 * See KNOWLEDGE-SPEC.md §8.2.
 *
 * @experimental
 */
export interface ProposalGateConfig {
  proposalKind: ProposalKind;
  /**
   * Restrict this config to specs attached to these node types. A
   * matching config with `nodeTypeIds` wins over one without.
   */
  nodeTypeIds?: NodeTypeId[];
  /** Which enforcement tiers apply. */
  enforcement: EnforcementTier[];
  /** Reviewer agents for the `agent_review` tier. */
  reviewers?: AgentId[];
  /** Stewards who may approve at the `human_gate` tier. Defaults to all. */
  approvers?: string[];
}

/**
 * Why a proposal cannot be applied as-is. Conflicts are surfaced, never
 * silently merged. See KNOWLEDGE-SPEC.md §9.
 *
 * @experimental
 */
export interface ProposalConflict {
  kind:
    | "stale_base"
    | "concurrent_proposal"
    | "section_removed"
    | "link_target_missing"
    | "taxonomy_violation";
  sectionId?: SpecSectionId;
  conflictingProposalId?: ChangeProposalId;
  conflictingRevisionId?: SpecRevisionId;
  detail: string;
  /**
   * For a section conflict, the three sides, so tools can show them side
   * by side: the section's body at the base revision, at the head, and as
   * proposed. Absent when that side has no section (added or removed).
   */
  baseText?: string;
  headText?: string;
  proposedText?: string;
  detectedAt: Timestamp;
}

/**
 * What caused a spec change proposal to be produced.
 *
 * @experimental
 */
export type SpecChangeTrigger =
  | "work_item_completed"
  | "work_item_progressed"
  | "manual"
  | "feedback";

/**
 * A proposed change to one spec, made against a base revision. Accepted
 * proposals become a new `SpecRevision` whose `cause` points back here.
 *
 * @experimental
 */
export interface SpecChangeProposal {
  id: ChangeProposalId;
  tenantId?: string;
  specId: SpecId;
  baseRevisionId: SpecRevisionId;
  operations: SpecChangeOperation[];
  rationale: string;
  evidence?: ProposalEvidence[];
  /** Work item whose progress or completion produced this proposal. */
  workItemId?: WorkItemId;
  trigger: SpecChangeTrigger;
  author: Attribution;
  /**
   * Everyone other than `author` who changed the draft's content while it
   * was edited collaboratively. None of them may pass its human gate.
   */
  contributors?: Attribution[];
  /** Questions settled while drafting, kept apart from the prose. */
  decisions?: ProposalDecision[];
  status: ChangeProposalStatus;
  /** Tier currently pending while `status` is `in_review`. */
  pendingTier?: EnforcementTier;
  reviews: ProposalReview[];
  /** Risk assessment, when the implementation makes one (§8.2). */
  risk?: ProposalRisk;
  conflicts?: ProposalConflict[];
  /** When rebased, the proposal this one replaces. */
  supersedes?: ChangeProposalId;
  /** Set when `status` is `accepted`. */
  resultingRevisionId?: SpecRevisionId;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Add a node type, or replace one with the same id.
 *
 * @experimental
 */
export interface UpsertNodeTypeOperation {
  op: "upsert_node_type";
  nodeType: NodeType;
}

/**
 * Add a relation type, or replace one with the same id.
 *
 * @experimental
 */
export interface UpsertRelationTypeOperation {
  op: "upsert_relation_type";
  relationType: RelationType;
}

/**
 * Deprecate a node or relation type, optionally naming a replacement.
 *
 * @experimental
 */
export interface DeprecateTypeOperation {
  op: "deprecate_type";
  target: "node_type" | "relation_type";
  typeId: string;
  supersededBy?: string;
}

/**
 * Replace the default delivery ladder, or one domain's ladder.
 *
 * @experimental
 */
export interface SetDeliveryLadderOperation {
  op: "set_delivery_ladder";
  ladder: NodeTypeId[];
  /**
   * Set this domain's entry in `TaxonomyDefinition.domainLadders` instead
   * of the default `deliveryLadder`. With `domain`, an empty `ladder`
   * removes the domain's entry, so it falls back to the default.
   *
   * @experimental
   */
  domain?: DomainId;
}

/**
 * An operation inside a `TaxonomyChangeProposal`.
 *
 * @experimental
 */
export type TaxonomyOperation =
  | UpsertNodeTypeOperation
  | UpsertRelationTypeOperation
  | DeprecateTypeOperation
  | SetDeliveryLadderOperation;

/**
 * A proposed change to a taxonomy. Goes through the same gates as a spec
 * change, by every domain that owns a type or ladder it touches
 * (KNOWLEDGE-SPEC.md §3.5); acceptance publishes `baseVersion + 1`.
 *
 * @experimental
 */
export interface TaxonomyChangeProposal {
  id: ChangeProposalId;
  tenantId?: string;
  taxonomyId: TaxonomyId;
  baseVersion: number;
  operations: TaxonomyOperation[];
  migrations?: NodeTypeMigration[];
  rationale: string;
  author: Attribution;
  /** See `SpecChangeProposal.contributors`. */
  contributors?: Attribution[];
  /** See `SpecChangeProposal.decisions`. */
  decisions?: ProposalDecision[];
  status: ChangeProposalStatus;
  pendingTier?: EnforcementTier;
  reviews: ProposalReview[];
  conflicts?: ProposalConflict[];
  supersedes?: ChangeProposalId;
  /** Set when `status` is `accepted`. */
  resultingVersion?: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// -----------------------------------------------------------------------
// Impact learning (feedback-on-feedback)
// -----------------------------------------------------------------------

/**
 * How a predicted (or unpredicted) spec impact turned out. Fed to a
 * `SpecImpactInferrer` so future inference improves.
 *
 * - `confirmed`: predicted, and an accepted proposal changed it.
 * - `rejected`: predicted, and the proposal was rejected at a gate.
 * - `unused`: predicted, but no proposal touched it.
 * - `missed`: not predicted, but an accepted proposal changed it.
 *
 * @experimental
 */
export interface SpecImpactOutcome {
  workItemId: WorkItemId;
  specId: SpecId;
  sectionId?: SpecSectionId;
  outcome: "confirmed" | "rejected" | "unused" | "missed";
  /** The entry that predicted this, if any. */
  predicted?: SpecImpactEntry;
  proposalId?: ChangeProposalId;
  recordedAt: Timestamp;
}

/**
 * Extension point for agents that infer which specs a work item will
 * change. Implementations traverse relations whose type sets
 * `impactPropagation`, and learn from outcomes.
 *
 * @experimental
 */
export interface SpecImpactInferrer {
  /** Infer spec impact for a work item. Entries carry `source: "inferred"`. */
  infer(workItemId: WorkItemId): Promise<SpecImpactEntry[]>;

  /** Called whenever a `SpecImpactOutcome` is recorded. */
  onOutcome(outcome: SpecImpactOutcome): void;
}
