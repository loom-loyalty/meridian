# Meridian Knowledge Model Specification

**Version:** 1.0.0-draft.1
**Status:** Draft
**Date:** October 2026
**License:** CC BY 4.0

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document defines the Meridian knowledge model: a tenant-defined, versioned taxonomy; a typed graph of business, architecture, and delivery nodes; living specs with immutable revisions; and the proposal flow by which finished work updates the specs it touched. The knowledge model is an operating pattern; see the [`README.md`](README.md) in this directory for the core/patterns boundary. All types referenced here live in `@loom-loyalty/meridian-types` (module `knowledge.ts`) and are `@experimental`.

---

## 1. Purpose

Domains say who is accountable. Work items say what is being done and what it costs. Neither says what the business _is_: which capabilities it has, which processes realize them, which solutions and applications support those processes, and what information flows between them. Organizations keep that knowledge in wikis and slide decks that drift from reality the day after they are written.

This specification defines a knowledge base that stays current because work keeps it current. When a task completes, the agent that did it proposes changes to the business specs the task affected. The proposal passes the same graduated enforcement as any other work, and once accepted it becomes a new spec revision with lineage back to the task.

Three commitments shape the model:

- **The taxonomy is data.** Which kinds of things exist (capability, business process, application, epic) and how they relate are defined per tenant, versioned, and changed through gated proposals. No protocol behavior depends on a particular type existing.
- **Specs change by proposal, never by overwrite.** Every change is attributed, gated, and recorded as an immutable revision linked to the work that caused it.
- **Agents learn what to change.** Impact is declared or inferred from the graph, carries a confidence score, and improves from the outcomes of past proposals.

---

## 2. The model at a glance

| Concept                  | Type                                        | What it is                                                                    |
| ------------------------ | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Taxonomy                 | `TaxonomyDefinition`                        | A versioned set of node types, relation types, and a delivery ladder          |
| Node type                | `NodeType`                                  | A tenant-defined kind of node, with a field schema and structural constraints |
| Relation type            | `RelationType`                              | A tenant-defined kind of directed edge, with type constraints and cardinality |
| Node                     | `KnowledgeNode`                             | A typed node in the graph, owned by a domain and stewarded by people          |
| Relation                 | `Relation`                                  | A typed, directed edge between two nodes                                      |
| Spec                     | `Spec`, `SpecSection`, `SpecRevision`       | A living document attached to a node, with stable section ids and revisions   |
| Spec impact              | `SpecImpact`, `SpecImpactEntry`             | The specs and sections a work item is expected to change                      |
| Spec change proposal     | `SpecChangeProposal`, `SpecChangeOperation` | A section-level change against a base revision, gated before it is applied    |
| Taxonomy change proposal | `TaxonomyChangeProposal`                    | A change to the taxonomy itself, gated the same way                           |
| Impact outcome           | `SpecImpactOutcome`, `SpecImpactInferrer`   | Feedback-on-feedback that improves future impact inference                    |

The graph is a graph, not a tree. A node MAY have one containment parent (`parentId`), constrained by its type's `allowedParentTypes`; every other structural fact is a relation.

---

## 3. Taxonomy as data

A `TaxonomyDefinition` belongs to a tenant and is stewarded by a domain (`TaxonomyDefinition.domain`), typically an architecture or operations domain. Its `version` is a monotonic integer starting at 1.

### 3.1 Node types

A `NodeType` declares:

- `id`, `label`, `description`.
- `fieldSchema`: a JSON-Schema-like schema that `KnowledgeNode.fields` is validated against. The dialect is implementation-defined; unknown keywords are permitted.
- `allowedParentTypes`: which types may be this type's containment parent. Omitted means any; an empty array means nodes of this type are always roots.
- `parentRequired`: when true, every node of this type MUST have a parent. Otherwise a node MAY be a root even when `allowedParentTypes` is non-empty.
- `allowedRelations`: which relation types nodes of this type may participate in. Omitted means any.
- `category`: a free-form grouping such as `business`, `architecture`, or `delivery`. Informational only.
- `workItemType`: for delivery types, the nearest built-in `WorkItemType` (§6).

### 3.2 Relation types

A `RelationType` declares `id`, `label`, an optional `inverseLabel` (`realizes` / `realized by`), allowed `fromTypes` and `toTypes` (omitted means any), and a `cardinality` read from the from-side: `one_to_one`, `one_to_many`, `many_to_one`, or `many_to_many`.

Two optional fields drive impact inference (§7.2): `impactPropagation` (`forward`, `reverse`, or `both`) says whether and how inference walks the edge, and `impactWeight` (0.0 to 1.0) scales confidence per hop.

### 3.3 Versioning and migration

Every accepted `TaxonomyChangeProposal` publishes exactly one new version. Versions are immutable once published.

Each `KnowledgeNode` records the `taxonomyVersion` its `fields` were last validated against. When a version changes a node type in a way that invalidates existing nodes (a new required field, a renamed field, a split or merged type), the proposal MUST carry a `NodeTypeMigration` for the affected type. A migration names `fromTypeId` and `toTypeId` (equal for an in-place schema change), an optional `fieldMap` (old name to new name, `null` to drop), `defaults` for newly required fields, an optional `valueMap` (per field, old value to new value, for a narrowed or renamed enum), and a `mode`:

- **`eager`** — every affected node is rewritten when the version is published. Suitable for small node counts.
- **`lazy`** — nodes keep their recorded `taxonomyVersion` and stay readable as-is; they are migrated on their next write. Readers that need current-version shape apply the migration on read.

Mechanical validation of a taxonomy proposal (§8.2) includes a dry run of its migrations against existing nodes. A proposal whose migration would leave any node invalid fails mechanical checks.

Changes that only add (a new type, a new optional field, a new relation type) need no migration.

### 3.4 Deprecation

Types are deprecated, not deleted. A `deprecated` node or relation type stays valid for existing data, so reads, relations, and spec links continue to work, but implementations MUST reject new nodes or relations of that type. `supersededBy` names the replacement, if any, so tools can suggest it. A type becomes `retired` only when no live (non-`archived`) node or relation of that type remains; retirement is itself a taxonomy change.

Type ids are never reused, so a revision or proposal from years ago still resolves to what its author meant.

### 3.5 Taxonomy changes are proposals

Taxonomy changes go through a `TaxonomyChangeProposal` made against a `baseVersion`, with `operations` (`upsert_node_type`, `upsert_relation_type`, `deprecate_type`, `set_delivery_ladder`), `migrations`, and a `rationale`. They pass the same tiers as spec changes (§8.2), with one difference: a taxonomy proposal always requires the `human_gate` tier, approved by a steward of the taxonomy's domain. Changing the vocabulary of the business is a strategic decision.

A taxonomy proposal whose `baseVersion` is no longer current is `conflicted`; taxonomy proposals are not rebased automatically.

---

## 4. The knowledge graph

### 4.1 Nodes

A `KnowledgeNode` carries `id`, `typeId`, `taxonomyVersion`, `title`, an optional `summary`, `fields` validated against its type's schema, an optional `parentId`, a lifecycle `status` (`draft`, `active`, `deprecated`, `archived`), and attribution (`createdBy`, timestamps).

Every node has exactly one owning `domain`: the `DomainId` accountable for it, in the sense of [`DOMAIN-SPEC.md`](DOMAIN-SPEC.md). Ownership determines who gates changes to the node and its specs (§8.2). `stewards` lists the `Steward.id` values responsible for the node day to day; they SHOULD be stewards of the owning domain.

Ownership is distinct from any `owned-by` relation a tenant's taxonomy might define. The `domain` field is accountability within Meridian; an `owned-by` relation is business content, such as which business unit a capability belongs to.

### 4.2 Relations

A `Relation` is a typed, directed edge (`from` → `to`) with optional edge `fields`. Implementations MUST reject a relation whose endpoints violate its type's `fromTypes`/`toTypes` or whose creation would exceed its `cardinality`. Relations MAY cross domains; they MUST NOT cross tenants (§11).

Relations are created and removed by any participant permitted to edit both endpoints. Relations that a spec section depends on are changed through the `relink` operation of a spec change proposal (§8.1), so the change is gated with the spec.

---

## 5. Specs and revisions

### 5.1 Specs and sections

A `Spec` is a living document attached to one node (`nodeId`). A node MAY have several specs. A spec has an owning `domain` (by default its node's domain), a `format` (the media type of section bodies, such as `text/markdown`), and a `headRevisionId`.

Content is organized in `SpecSection`s. Each section has a **stable id** (`SpecSectionId`) that survives heading edits, reordering, and revisions, and that is never reused after the section is removed. Section ids are what proposals, impact entries, and links address; headings are for people. Sections MAY nest via `parentSectionId` and MAY carry typed `links` (`SpecLink`) to nodes, specs, or sections.

A section MAY name its own `owningDomain` when one part of a spec belongs to a different team (for example, the data-retention section of a capability spec owned by the data governance domain). A section without `owningDomain` inherits it from its parent section, and a top-level section from the spec. The effective owning domain of a section decides who gates changes to it (§8.2) and who may approve them (§11).

### 5.2 Revisions

A `SpecRevision` is an immutable snapshot of all sections of a spec, in document order. Revisions are numbered monotonically per spec and chain through `parentRevisionId`. Every revision records its `author` and a `cause`: the work item and/or proposal that produced it. Only a spec's first revision MAY have an empty cause.

Implementations MUST NOT modify a revision after creation and MUST NOT change `headRevisionId` except by applying an accepted proposal (§8) or creating a spec's first revision.

---

## 6. The delivery ladder

Work items are knowledge nodes of delivery types. A work item's `id` is also its `KnowledgeNodeId`, so the graph can relate a task to the capability it implements just as it relates an application to the capability it realizes.

The ladder (the ordered list of delivery types from top to bottom) is taxonomy data: `TaxonomyDefinition.deliveryLadder`. The default ladder is:

```
program > project > epic > story > task
```

`program` and `project` are taxonomy types, not new built-in values: both map to the built-in `initiative` (`NodeType.workItemType`), so the stable `WorkItemType` union is unchanged. The seed taxonomy (§12) also keeps a plain `initiative` delivery type outside the default ladder, which can sit at the top level and parent projects and epics. Existing initiative → epic → story → task trees stay valid without migration.

Tenants MAY rename, add, or remove rungs. Because the built-in `WorkItemType` union is a stable contract that gates (`GateConfig.workItemType`) and priority engines already key on, each tenant-defined delivery type declares the nearest built-in value in `NodeType.workItemType`. A work item of a tenant-defined type carries that built-in value in `WorkItem.type` and the tenant type in `WorkItem.typeId`. Consumers that do not understand the tenant taxonomy keep working on `type`.

A work item's position on the ladder is its containment parent, `WorkItem.parentId`, constrained by its type's `allowedParentTypes`. `lineage` keeps its existing meaning (what spawned the item) and is not a substitute for `parentId`.

---

## 7. Spec impact

### 7.1 Declared impact

A work item MAY carry a `SpecImpact`: the specs and sections it is expected to change. Each `SpecImpactEntry` names a `specId`, optional `sectionIds` (omitted means the whole spec, or a new section for `add`), an `intent` (`add`, `change`, `remove`, or `verify`), a `source` (`declared` or `inferred`), and a `confidence` from 0.0 to 1.0. `verify` means the spec should be checked against the finished work but probably will not change.

Impact is a forecast, not a lock. Declaring impact on a section does not prevent other work from proposing changes to it, and work MAY propose changes it did not declare.

### 7.2 Inferred impact

When no impact is declared, or to supplement a declaration, an agent MAY infer impact from the graph. The reference approach:

1. Start at the work item's node.
2. Walk up `parentId` along the delivery ladder (task → story → epic → …).
3. From each visited node, follow relations whose type sets `impactPropagation` in the direction it allows (for example, `implements` forward from an epic to a capability, then `realizes` in reverse from the capability to the solutions that realize it).
4. Collect the specs attached to visited nodes. Prefer sections whose `links` point at visited nodes.
5. Score each candidate as the product of the `impactWeight` of every edge on the path, with a per-hop decay chosen by the implementation. Drop candidates below a threshold.

Inferred entries carry `source: "inferred"` and the traversal as `path`, so reviewers can see why the agent thinks a spec is affected. The traversal rule is non-normative; the `SpecImpactInferrer` interface is the extension point for implementations that do better.

### 7.3 Conformance

Implementations MUST store declared impact and MUST keep `source` and `confidence` as given. Implementations SHOULD infer impact when a work item completes, through a `SpecImpactInferrer`. The inference algorithm itself is not normative and conformance does not test it, so implementations can compete on it.

---

## 8. Spec change proposals

### 8.1 Shape

A `SpecChangeProposal` targets one spec. It records the `baseRevisionId` it was written against, an ordered list of section-level `operations`, a `rationale`, optional `evidence` (commits, test results, feedback signals, documents), the `workItemId` that produced it, the `trigger` (`work_item_completed`, `work_item_progressed`, `manual`, or `feedback`), and its `author`.

Operations:

- **`add_section`** — insert a new section, optionally after an anchor section. The new section id MUST NOT collide with any id the spec has ever used.
- **`replace_section`** — replace a section's body and optionally its heading.
- **`remove_section`** — remove a section; its id is retired.
- **`move_section`** — move a section to a new position (after a sibling, first, or last) and optionally under a new parent, keeping its id, content, and links.
- **`relink`** — add or remove typed links on a section.

`replace_section`, `remove_section`, and `move_section` MAY carry the section's `baseContentHash`, which makes rebase checks (§9.1) cheap and exact.

A work item that changes several specs produces one proposal per spec. Implementations SHOULD link them through the shared `workItemId` so reviewers see them together.

### 8.2 Gates

Proposals pass the graduated enforcement tiers from [`FEEDBACK-PROCESSING-SPEC.md`](FEEDBACK-PROCESSING-SPEC.md) §3.5. Each tier's outcome is recorded as a `ProposalReview`, which pairs a `QualitySignal` (with `enforcementTier` set) with the reviewer's `Attribution`.

**Mechanical.** Always runs. Checks that every operation addresses a section that exists (or, for `add_section`, does not yet exist) at the base revision; that resulting sections validate against the spec's format; that every link resolves to a live node, spec, or section and respects the relation type's constraints; and that the base revision is current or rebasable (§9.1). A mechanical failure moves the proposal to `rejected`, or to `conflicted` when the cause is a conflict.

**Agent review.** Reviewer agents check consistency with related specs and the taxonomy: does the new capability description contradict the solution spec that realizes it, does the change reference deprecated types, does it match what the work item actually did. Reviewers MAY attach `CompetingContext` through the usual feedback path.

**Human gate.** A steward of the spec's owning domain approves or rejects.

**Provenance.** A `ProposalReview` MAY carry a `basis` saying how it was reached.

- `written` (the default when `basis` is absent): the reviewer examined the change and wrote the signal.
- `decided`: a decision model predicted the reviewer's verdict with a calibrated `probability`, and no written review exists. Its `reviewer` is the decision agent, and `standsInFor` names the reviewer it replaces.
- Decision models can be steered by the text they read. A `decided` review therefore MUST NOT be the only agent review of a proposal that will be applied without a human gate: the reviewer it stands in for MUST write its review instead.
- An agent's `Attribution` MAY name the model behind it (`model`), and whether that model was the agent's default, an operator's pin, or `routed` per call by another model.

**Risk.** An implementation MAY assess how much harm a proposal could do if it were wrong and applied unchecked, as a `ProposalRisk` with a probability per ordered level.

- An assessment MAY add the human gate for every touched domain to a proposal that its domains would otherwise apply without one. It is then `escalated`.
- Implementations SHOULD escalate on the probability of the higher levels, not on the probability-weighted score alone, so a small chance of a severe change is not averaged away.
- A risk assessment MUST NOT remove a gate, and MUST NOT reject a proposal on its own.

Which of agent review and human gate apply is configured by the owning domain's stewards with a `ProposalGateConfig` in `Domain.proposalGates`, keyed by `proposalKind` (`"spec_change"` or `"taxonomy_change"`). A config MAY narrow itself to specs attached to particular node types (`nodeTypeIds`) and MAY name the reviewer agents for the agent review tier (`reviewers`) and the stewards who may approve at the human gate (`approvers`). When several configs match, the one with `nodeTypeIds` wins over the one without. When none matches, all three tiers apply. The mechanical tier always runs whatever the config says, and taxonomy proposals always include the human gate (§3.5).

**Proposals that span domains.** A proposal whose operations touch sections with different effective owning domains (§5.1) is gated by each of those domains: the tiers that apply are the union of the tiers each domain's config requires, and the human gate needs an approving review from a steward of every domain whose sections the proposal touches that requires it.

### 8.3 Lifecycle

```
draft → in_review (mechanical → agent_review → human_gate) → accepted
            │                                              ↘ rejected
            └─→ conflicted → (author rebases) → superseded, replaced by a new proposal
draft | in_review | conflicted → withdrawn
```

`pendingTier` names the tier in progress while the proposal is `in_review`.

On acceptance, the implementation applies the operations to the current head, creates a new `SpecRevision` whose `cause` names the proposal and work item and whose `author` is the proposal's author, sets `resultingRevisionId`, and advances `headRevisionId`. Applying MUST be atomic with respect to the head: if the head moved after the last mechanical check, mechanical checks run again before applying.

**Retention.** Implementations MUST keep every proposal in a terminal state (`accepted`, `rejected`, `superseded`, `withdrawn`), with its operations, reviews, and conflicts, for as long as the tenant's knowledge base exists. Rejected and superseded proposals are the input to impact learning (§10) and the audit trail of what the business decided not to do. The only exception is deletion that the tenant's data-retention policy or applicable law requires; implementations SHOULD support exporting proposals before such deletion.

### 8.4 Collaborative drafting

A proposal in `draft` MAY be edited by several people and agents at once, for example as a live multiplayer document with a chat beside it. The editing transport (CRDT, operational transform, locking) is outside this specification. What it produces is not:

- **Drafts are not specs.** Live edits change the draft only. The spec's head still moves only when a submitted proposal is accepted (§5.2), and the draft is converted to section-level `operations` against its `baseRevisionId` when it is submitted.
- **Contributors.** Everyone other than the `author` who changed the draft's content is listed in `contributors`. The author is whoever submits it.
- **Decisions.** Questions settled while drafting are recorded as `ProposalDecision`s with who decided them, separate from the prose. Reviewers at the `agent_review` tier SHOULD check that the operations agree with the recorded decisions. Decisions are retained with the proposal (§8.3).
- **Agents edit as themselves.** An agent's edits to a draft are attributed to the agent (with `onBehalfOf` when it acts for a person), so reviewers can see which parts an agent wrote.

## Taxonomy proposals MAY be drafted the same way.

## 9. Concurrency and conflicts

Many agents finishing many tasks will propose changes to the same specs. The model resolves this at section granularity and never merges conflicting content silently.

### 9.1 Stale base and rebase

A proposal's base is **current** when `baseRevisionId` equals the spec's head. It is **rebasable** when every section the proposal touches is unchanged between base and head (same `contentHash`, or identical heading, body, and links) and every `add_section` and `move_section` anchor (and new parent) still exists. A rebasable proposal MAY be rebased mechanically: the implementation updates `baseRevisionId` and records a mechanical check named `rebase` in that tier's `QualitySignal`. Because rebasing only happens when the touched sections are unchanged, existing agent-review and human-gate approvals remain valid.

A proposal that is neither current nor rebasable moves to `conflicted` with a `stale_base` or `section_removed` conflict naming the section and the revision that changed it. A section conflict SHOULD carry the three sides in `baseText`, `headText`, and `proposedText`, so a reviewer or the author can compare them side by side; nothing is merged for them. Only the author (or its delegate) can resolve it, by opening a new proposal against the new head with `supersedes` pointing at the old one. The new proposal runs every tier again.

### 9.2 Concurrent proposals

When a proposal enters `in_review` while another open proposal on the same spec touches any of the same sections, the implementation MUST record a `concurrent_proposal` conflict on both, naming the other. Both MAY continue through review; reviewers see each other's proposal. Whichever is accepted first advances the head; the other then fails its rebase check for the shared sections and becomes `conflicted` (§9.1).

Implementations MUST NOT combine edits from two proposals into one section without a new proposal that a reviewer can see. Text-level three-way merge within a section is a tool an author may use to prepare a rebased proposal, never something the system applies on its own.

### 9.3 Cross-object conflicts

A `link_target_missing` conflict arises when a link's target is archived or removed after the proposal was written. A `taxonomy_violation` arises when a taxonomy version published after the proposal was written makes it invalid (for example, a relation type it links with is now deprecated). Both are surfaced the same way, as conflicts the author resolves.

---

## 10. Agent change knowledge

An agent "knows what to change" by combining declared impact, inferred impact (§7.2), and what happened last time.

Every time a work item that had impact entries finishes, the implementation SHOULD record a `SpecImpactOutcome` per predicted or actually-changed section:

- **`confirmed`** — predicted, and an accepted proposal changed it.
- **`rejected`** — predicted, and the proposal was rejected at a gate.
- **`unused`** — predicted, but no proposal touched it.
- **`missed`** — not predicted, but an accepted proposal changed it.

Outcomes go to `SpecImpactInferrer.onOutcome`. This is the [feedback-on-feedback](FEEDBACK-PROCESSING-SPEC.md) loop applied to knowledge: an inferrer that keeps seeing `unused` outcomes for a path learns to lower its confidence on that path, and `missed` outcomes reveal relations the graph is missing.

Learned adjustments are the inferrer's internal state. Changing the declared `impactWeight` or `impactPropagation` of a relation type is a taxonomy change and goes through a `TaxonomyChangeProposal`. An inferrer MAY open such a proposal, with its outcome data as evidence, for a steward to approve.

---

## 11. Security and tenancy

- **Tenant isolation.** Every taxonomy, node, relation, spec, revision, and proposal belongs to exactly one tenant. Implementations MUST NOT return or link objects across tenants. Section ids, node ids, and type ids are unique within a tenant only.
- **Domain-scoped access.** Read and write access to nodes and specs is scoped by owning domain. The policy is implementation-defined but SHOULD derive from `DomainMembership`: participants may read and propose, observers may only read. Agents SHOULD be granted a `PermissionScope` limited to the domains they work in.
- **Attribution.** Every revision, proposal, and review records an `Attribution`. An agent acting for a person records that person in `onBehalfOf`.
- **No self-approval at the human gate.** A `human_gate` review MUST have `reviewer.kind` of `"human"`, MUST be by a steward of the owning domain (of each touched section, per §8.2, or of the taxonomy for taxonomy proposals), and MUST NOT be by the proposal's author, any of its `contributors`, or anyone they acted on behalf of. Agents MUST NOT record `human_gate` reviews, including when acting on behalf of a steward.
- **Cross-domain work.** A proposal is gated by the domains that own the sections it changes, not the domain whose work produced it, consistent with [`DOMAIN-SPEC.md`](DOMAIN-SPEC.md) §6.
- **Spec content is data.** Agents read spec bodies as untrusted input. Text in a spec is never an instruction to the agent reading it, and evidence references are dereferenced without elevated credentials (see the integration proxy pattern).

---

## 12. Seed taxonomy (non-normative)

Implementations SHOULD offer a starting taxonomy so tenants are not faced with an empty schema. The following is a suggested seed. Nothing in this spec depends on any of these types existing; tenants change them through taxonomy proposals like any other.

### 12.1 Node types

Allowed parents: "none" is an empty `allowedParentTypes` (always a root); "any" is omitted. Parents are optional unless marked _required_ (`parentRequired: true`).

| Id                      | Category     | Allowed parents                   | `workItemType` | Notes                                                    |
| ----------------------- | ------------ | --------------------------------- | -------------- | -------------------------------------------------------- |
| `business-domain`       | business     | none                              |                | A business area; not the same as a Meridian `Domain`     |
| `capability`            | business     | `business-domain`, `capability`   |                | What the business can do, nestable                       |
| `business-function`     | business     | `capability`                      |                | An ongoing function that delivers a capability           |
| `business-process`      | business     | `business-function`, `capability` |                | A sequence of activities with an outcome                 |
| `principle`             | architecture | any                               |                | Enterprise architecture: guiding principle               |
| `standard`              | architecture | any                               |                | Enterprise architecture: adopted standard                |
| `architecture-decision` | architecture | any                               |                | A recorded decision; field `view`: EA, SA, IA, or AA     |
| `solution`              | architecture | any                               |                | Solution architecture: a solution realizing capabilities |
| `information-entity`    | architecture | `information-entity`              |                | Information architecture: a business object or data set  |
| `application`           | architecture | none                              |                | Application architecture: a deployed application         |
| `application-component` | architecture | `application` (_required_)        |                | Application architecture: a component or service         |
| `program`               | delivery     | none                              | `initiative`   | Ladder rung 1                                            |
| `project`               | delivery     | `program`, `initiative`           | `initiative`   | Ladder rung 2                                            |
| `epic`                  | delivery     | `project`, `initiative`           | `epic`         | Ladder rung 3                                            |
| `story`                 | delivery     | `epic` (_required_)               | `story`        | Ladder rung 4                                            |
| `task`                  | delivery     | `story` (_required_)              | `task`         | Ladder rung 5                                            |
| `initiative`            | delivery     | `program`                         | `initiative`   | Kept for compatibility; not on the default ladder        |

Application architecture is deliberately thin. When agents build and maintain applications, the application layer changes too fast to be worth modeling by hand; tenants who need more detail add it.

### 12.2 Relation types

| Id           | From → to                                                                         | Cardinality  | `impactPropagation` |
| ------------ | --------------------------------------------------------------------------------- | ------------ | ------------------- |
| `implements` | delivery types → any non-delivery type                                            | many_to_many | forward             |
| `realizes`   | `solution`, `application`, `business-process` → `capability`                      | many_to_many | both                |
| `depends-on` | any → any                                                                         | many_to_many | reverse             |
| `uses`       | `application`, `application-component`, `business-process` → `information-entity` | many_to_many | forward             |
| `governs`    | `principle`, `standard`, `architecture-decision` → any                            | many_to_many | forward             |
| `owned-by`   | any → `business-domain`                                                           | many_to_one  | (none)              |
| `supersedes` | any → same type                                                                   | one_to_one   | (none)              |

With this seed, inference from a task follows `parentId` to its epic, `implements` to a capability, and `realizes` in reverse to the solutions and processes that realize it, giving the chain task → story → epic → capability → specs.

---

## 13. Non-goals

This specification does not define:

- **A document editor or UI.** How people read, write, or review specs is up to the implementation. The spec defines the data and the change flow.
- **A search engine or retrieval layer.** Full-text search, embeddings, and ranking are implementation concerns. Graph traversal for impact inference is the only query behavior described, and it is non-normative.
- **A storage engine.** Graph databases, relational tables, and document stores are all fine.
- **A fixed taxonomy.** The seed in §12 is a suggestion.
- **Wire message types.** Knowledge objects travel as ordinary payloads in this draft. Dedicated frame types (like `PRIORITY_QUERY`) wait until a reference implementation shows which exchanges are hot enough to need them.
- **Text merging.** The system surfaces conflicts; it does not resolve them on anyone's behalf (§9).

---

## 14. Versioning and stability

All types in this specification are `@experimental` and may change in minor versions of `@loom-loyalty/meridian-types`. The only change to stable types is additive and optional: `WorkItem` gains `parentId`, `typeId`, and `specImpact`. The stable `WorkItemType` union is unchanged. The `program` and `project` rungs of the default ladder are taxonomy types that map to the built-in `initiative`.

---

## 15. Resolved questions

Earlier drafts left these open. Each is now settled in the section named:

- **Wire message types for proposals:** not yet (§13).
- **Dedicated gate configuration for proposals:** `ProposalGateConfig` in `Domain.proposalGates` (§8.2).
- **Section-level ownership:** optional `SpecSection.owningDomain`; proposals that span domains are gated by each (§5.1, §8.2).
- **Normative impact inference:** no. Declared impact is required, inference is SHOULD, and the algorithm stays an extension point (§7.3).
- **Retention of rejected and superseded proposals:** kept for the life of the knowledge base, unless policy or law requires deletion (§8.3).

---

_Draft document. Comments welcome via pull request._
