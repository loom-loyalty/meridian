# Meridian MCP Binding Specification

**Version:** 1.0.0-draft.2
**Status:** Draft (experimental)
**Date:** October 2026
**License:** CC BY 4.0

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document defines an experimental binding of Meridian to the [Model Context Protocol](https://modelcontextprotocol.io) (MCP): a catalogue of tools, with names, inputs, outputs, and permission rules, that any conformant runtime can serve so that AI assistants and externally hosted coding agents can work inside a Meridian system. Through it they read the inbox, board, specs, and taxonomy; claim, create, and move work; report heartbeats and cost while they work; declare spec impact; propose spec and taxonomy changes; and emit feedback. The binding is an operating pattern; see the [`README.md`](README.md) in this directory for the core/patterns boundary. It defines a contract only, not a server. All types referenced here live in `@loom-loyalty/meridian-types` (module `mcp.ts`, plus `WorkItemClaim` and `WorkItemLink` in `work-item.ts`) and are `@experimental`.

---

## 1. Purpose

Meridian agents are spawned by a runtime and talk to each other in MessagePack frames. A lot of real work is now done by agents that a Meridian runtime did not spawn: a coding session in a terminal or a cloud sandbox, or a chat assistant working with a person. These agents already speak MCP. Without a shared binding, each runtime would invent its own tool names and shapes, and each would have to decide again what such an agent may do: whether it may approve its own work, move gated items, or change budgets.

This specification fixes those answers once:

- **One tool catalogue.** The same `meridian_*` tools, with the same inputs and outputs, on any conformant runtime. An assistant configured against one runtime works against another.
- **Two permission tiers.** `read` and `propose`. Nothing in the binding approves, rejects, or reconfigures.
- **Existing shapes.** Tools return the types the other specs already define (`WorkItem`, `PrioritizedWorkItem`, `Spec`, `SpecChangeProposal`, `FeedbackSignal`, `Domain`). The binding adds request and response envelopes, a claim-with-lease, and artifact links, and nothing else.

---

## 2. Relationship to the wire protocol

MCP carries JSON-RPC over stdio or Streamable HTTP. The [wire protocol](../core/WIRE-PROTOCOL-SPEC.md) carries MessagePack over WebSocket. The two do not compete:

- **The MCP server is an LLM boundary.** The wire protocol already decodes payloads to minified JSON where content enters a model's context (WIRE-PROTOCOL-SPEC.md §6, `payloadToJSON()`). An MCP tool result is exactly such an injection point: its consumer is a model. The binding moves that conversion from inside an agent to the edge of the runtime.
- **Agent-to-agent traffic stays MessagePack.** An MCP client is never a peer on the WebSocket mesh. It does not send or receive frames. When a tool call causes work inside the runtime (a priority query, a feedback route, a reviewer agent picking up a proposal), that traffic uses the wire protocol as usual.
- **Same data model.** MessagePack and JSON share a data model (maps, arrays, strings, numbers, null), so every type in this binding round-trips between the two without a separate schema. Binary data does not appear in any tool shape.

Tool results SHOULD be compact: servers SHOULD serialize text content as minified JSON, as `payloadToJSON()` does.

---

## 3. External agents

### 3.1 Identity

The [runtime spec](../core/RUNTIME-SPEC.md) assumes agents it spawns. An **external agent** is an agent the runtime did not spawn and does not host: a coding session, a chat assistant, a CI bot. It participates in Meridian only through this binding.

An external agent is described by an `ExternalAgent`:

| Field         | Type                 | Meaning                                                                                                 |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `agentId`     | `AgentId`            | Minted by the runtime when it issues the token, e.g. `claude-session:01J…`. Never chosen by the client. |
| `host`        | `ExternalAgentHost`  | `kind` (free-form, e.g. `cli`, `cloud_session`, `chat`), optional `label`, optional `sessionUrl`        |
| `onBehalfOf`  | `string`             | The human the agent acts for, when it acts for one                                                      |
| `memberships` | `DomainMembership[]` | Declared participation per [`DOMAIN-SPEC.md`](DOMAIN-SPEC.md) §4: `participant` or `observer`           |
| `permissions` | `PermissionScope`    | Service patterns and domains this token may touch (§4)                                                  |
| `tier`        | `McpPermissionTier`  | `read` or `propose` (§4)                                                                                |
| `issuedAt`    | `Timestamp`          | Token issue time                                                                                        |
| `expiresAt`   | `Timestamp`          | Optional token expiry                                                                                   |

The runtime records every write made through the binding with the `Attribution` `{ kind: "agent", id: agentId, onBehalfOf }`. Clients MUST NOT be able to set or override attribution: no tool input carries an `author`, `createdBy`, `declaredBy`, or `reviewer` field, and servers MUST ignore such fields if sent. An `Attribution.model` reported by the client is informational and MUST NOT affect authorization.

An external agent is an agent for every purpose in the other specs. In particular it **can never record a `human_gate` review**, including when it acts on behalf of a steward ([`KNOWLEDGE-SPEC.md`](KNOWLEDGE-SPEC.md) §11). A proposal authored by an agent acting for a steward cannot be approved at the human gate by that steward; another steward of the domain must approve it.

### 3.2 Authentication

How the token is issued is implementation-defined. Remote servers SHOULD follow MCP's authorization profile (OAuth 2.1). Each token resolves to one `ExternalAgent`. A runtime MAY mint one agent per session, per client registration, or per human and client pair; the first gives the most precise attribution and is RECOMMENDED for coding sessions.

---

## 4. Permissions

### 4.1 Tiers

| Tier      | Grants                                                                                  |
| --------- | --------------------------------------------------------------------------------------- |
| `read`    | The read tools (§5.1)                                                                   |
| `propose` | The read tools and the propose tools (§5.2): create, move, claim, link, propose, report |

There is no third tier. Approving, rejecting, and reconfiguring are not available through the binding at any tier (§6).

A runtime that issues OAuth scopes maps them onto the tiers; for example, scopes named `kb:read` and `kb:propose` map to `read` and `propose`.

### 4.2 Mapping to PermissionScope

The tier is enforced through `PermissionScope.services` ([`RUNTIME-SPEC.md`](../core/RUNTIME-SPEC.md) §3). Each tool has the service name `meridian.<tier>.<tool>`, where `<tool>` is the tool name without its `meridian_` prefix: `meridian.read.inbox`, `meridian.propose.claim_work_item`. The `read` tier is the pattern `meridian.read.*`; the `propose` tier is `meridian.read.*` and `meridian.propose.*`. A runtime MAY grant narrower patterns (for example, propose tools except `propose_taxonomy_change`).

### 4.3 Effective access

The effective access of a call is the intersection of:

1. the token's tier and `PermissionScope.services`;
2. `PermissionScope.domains` (empty means every domain the agent is a member of);
3. the agent's declared `memberships`, and, when the agent acts for a human, that human's own memberships: `observer` allows read tools only; `participant` allows propose tools too.

This is the invocation-scope rule of RUNTIME-SPEC.md §4.5 applied to external agents: a token can never do more than the human it acts for. Servers SHOULD list in `tools/list` only the tools the token's tier permits. Every `meridian_*` tool of §5 MUST still answer a call with a tool result, whether or not the server lists it for the token: a call outside the effective access is an `isError` tool error with `permission_denied`, reason `tier_required` when the tier does not grant the tool and `not_participant` when the agent (or the human it acts for) is an observer or not a member of a domain the call acts on. Only names outside the catalogue may fail as JSON-RPC unknown-tool errors (§7).

Objects a call may read are scoped by owning domain, as KNOWLEDGE-SPEC.md §11 describes. Tenant isolation applies unchanged: no tool returns or links objects across tenants.

---

## 5. Tool catalogue

All tools are named `meridian_<verb>_<noun>` in `snake_case`. The prefix `meridian_` is reserved for tools defined here; a runtime's own extra tools MUST use another prefix and are still bound by §6.

| Tool                               | Tier      | Purpose                                                              |
| ---------------------------------- | --------- | -------------------------------------------------------------------- |
| `meridian_inbox`                   | `read`    | What needs the calling human: gates, blocked work, budget alerts     |
| `meridian_list_work_items`         | `read`    | The board: filtered, sorted, paginated work items with priority      |
| `meridian_get_work_item`           | `read`    | One work item with its context bundle                                |
| `meridian_search`                  | `read`    | Text search across work items, nodes, specs, sections, and proposals |
| `meridian_get_spec`                | `read`    | A spec at head or at a revision, optionally only some sections       |
| `meridian_get_taxonomy`            | `read`    | The taxonomy, optionally resolved for one domain                     |
| `meridian_get_domain`              | `read`    | Stewards, budget, gates, proposal gates, and priority weights        |
| `meridian_get_proposal`            | `read`    | A spec or taxonomy change proposal with its human-gate handoff       |
| `meridian_create_work_item`        | `propose` | Create a work item in `proposed`                                     |
| `meridian_transition_work_item`    | `propose` | Change status with a note; gated transitions return `pending`        |
| `meridian_claim_work_item`         | `propose` | Take a lease on a work item before working it                        |
| `meridian_renew_claim`             | `propose` | Extend a lease the caller holds                                      |
| `meridian_release_work_item`       | `propose` | Give up a lease                                                      |
| `meridian_link_artifact`           | `propose` | Attach a pull request, branch, CI run, session, or other link        |
| `meridian_declare_impacts`         | `propose` | Declare the specs and sections a work item will change               |
| `meridian_propose_spec_change`     | `propose` | Open a spec change proposal                                          |
| `meridian_propose_taxonomy_change` | `propose` | Open a taxonomy change proposal                                      |
| `meridian_withdraw_proposal`       | `propose` | Withdraw a proposal the caller authored                              |
| `meridian_emit_feedback`           | `propose` | Emit a heartbeat, cost, error, metric, insight, or competing context |

The input and output of each tool are `McpToolInputs[name]` and `McpToolOutputs[name]` in `mcp.ts`. Read tools MUST set the MCP annotation `readOnlyHint: true`. Propose tools set `readOnlyHint: false` and `destructiveHint: false`, except `meridian_withdraw_proposal`, whose effect is terminal (`destructiveHint: true`).

Propose tools that create something accept an optional `idempotencyKey`. A server that sees the same key from the same agent within 24 hours MUST return the original result instead of creating a second object.

### 5.1 Read tools

**`meridian_inbox`** — entries that need the calling human. Requires an agent that acts on behalf of a human; otherwise `permission_denied`.

| Entry kind                      | When it appears                                                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposal_awaiting_human_gate`  | A proposal is `in_review` at `human_gate` and the human is an eligible approver (a steward of a touched domain, in `approvers` if set, and not excluded by KNOWLEDGE-SPEC.md §11) |
| `work_item_awaiting_human_gate` | A work item's transition is pending at a `human_gate` the human may approve                                                                                                       |
| `blocked_work_item`             | A work item the human stewards (listed in the item's node `stewards`, or a steward of its domain when none is listed) is blocked                                                  |
| `proposal_conflicted`           | A proposal authored by the human, or by an agent on their behalf, is `conflicted` and needs a rebase                                                                              |
| `budget_alert`                  | A domain the human stewards has `currentSpendUsd / monthlyLimitUsd ≥ alertThreshold`                                                                                              |

Input: optional `kinds`, `domain`, `cursor`, `limit`. Output: `McpInboxOutput` with the resolved `principal` (`McpPrincipal`: the caller's agent, human, tier, and domain roles), `entries`, and `nextCursor`. Order is implementation-defined; entries that wait on the human's gate SHOULD come first.

**`meridian_list_work_items`** — the board. A board view, not a pull query: unlike `PRIORITY_QUERY`, it includes `proposed` and escalated items so people can see them.

| Input field          | Meaning                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `domain`             | Items whose `domains` include it                                                                                                  |
| `scopeNodeId`        | Items in the containment subtree (`parentId`) of a node. For a non-delivery node, items directly related to it and their subtrees |
| `typeIds`, `types`   | Tenant ladder types (`WorkItem.typeId`) and built-in `WorkItemType` values                                                        |
| `ladderRung`         | 0-based position on the domain's resolved ladder (KNOWLEDGE-SPEC.md §6), or on the default ladder without `domain`                |
| `statuses`           | Default: every status except `done` and `cancelled`                                                                               |
| `blocked`            | Only items with (or without) a `McpBlockedReason`                                                                                 |
| `claimed`            | Only items with (or without) an unexpired claim                                                                                   |
| `sort`, `order`      | `priority` (default, desc), `cost_of_delay` (desc), `cost_to_build` (asc), `net_value` (desc)                                     |
| `costBasis`          | `own` (default) or `rollup`                                                                                                       |
| `includeExplanation` | As in `AgentPriorityQuery`. Default `true`                                                                                        |
| `cursor`, `limit`    | Pagination (§8)                                                                                                                   |

Output: `McpListWorkItemsOutput`, which mirrors `AgentPriorityResponse` ([`PRIORITY-ENGINE-SPEC.md`](PRIORITY-ENGINE-SPEC.md) §2.3): `items`, `pendingReviewReasons`, `domainBudgetStatus`, `queriedAt`, plus `nextCursor`. Each page's `pendingReviewReasons` carries the competing contexts of the escalated items on that page. Each item is a `McpWorkItemEntry`, a `PrioritizedWorkItem` with optional `rollup`, `blocked`, and `claim`.

- `priorityScore` is `null` for an item the engine did not score. The reason is `priorityAnnotation` (`escalated`, `circuit_breaker`) or the status (`proposed` and terminal items are not scored, WORK-ITEM-SPEC.md §6). With `sort: "priority"`, unscored items come last.
- `cost_of_delay` sorts by `costOfNotBuilding.amountUsd`; `net_value` by `costOfNotBuilding.amountUsd − costToBuild.amountUsd`. With `costBasis: "rollup"`, both use the rolled-up totals.
- `rollup` (`McpCostRollup`) totals the item and all of its non-cancelled descendants: `costToBuildUsd`, `costOfNotBuildingUsd`, `itemCount`, and `unestimatedCount` (descendants still in `proposed`). A parent's cost of not building may already include its children's, so rolled-up cost of not building is an upper bound. `costBasis` never changes `priorityScore`.
- `claim` is the item's unexpired claim and is authoritative. Wherever a server presents a `WorkItem` (here, in `meridian_get_work_item`, and in any output), `WorkItem.claim` MUST show only an unexpired claim: it is omitted once the lease has expired or been released.
- `blocked` lists `McpBlockedReason`s: `escalated`, `circuit_breaker` (PRIORITY-ENGINE-SPEC.md §3, §4), `awaiting_human_gate`, `dependency` (implementation-defined, typically an unfinished item it depends on), `other`.

**`meridian_get_work_item`** — input `workItemId`, optional `includeExplanation`. Output `McpWorkItemContext`:

| Field               | Meaning                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `item`              | The `McpWorkItemEntry`, with `claim` and `links`                                                                               |
| `ancestors`         | The `parentId` chain, root first                                                                                               |
| `childCount`        | Number of direct children                                                                                                      |
| `childStatusCounts` | Direct children by `WorkItemStatus`                                                                                            |
| `inferredImpact`    | Impact the runtime infers through its `SpecImpactInferrer` (KNOWLEDGE-SPEC.md §7.2), beside the declared `workItem.specImpact` |
| `relatedSpecs`      | `McpRelatedSpec`s: specs named by impact (declared or inferred) and specs attached to the item's node                          |
| `proposals`         | `McpProposalSummary`s of proposals whose `workItemId` is this item                                                             |
| `actualCost`        | `McpActualCost`: cost reported against the item so far (§5.3), total and per domain                                            |
| `handoff`           | When a transition of this item waits at a human gate, the `McpHumanGateHandoff` (§6)                                           |

**`meridian_search`** — input `query`, optional `kinds` (`work_item`, `node`, `spec`, `section`, `proposal`), `domain`, `cursor`, `limit`. Output: `McpSearchHit`s (`kind`, `id`, `title`, `snippet`, `domain`, and for sections `specId`). Ranking, matching, and the index are implementation-defined (KNOWLEDGE-SPEC.md §13).

**`meridian_get_spec`** — input `specId`, optional `revisionId` (default: head) and `sectionIds` (default: all; a listed section brings its descendants). Output: `spec`, the `revision` without its sections, the `sections` selected in document order, `isHead`, and the ids of open proposals on the spec.

**`meridian_get_taxonomy`** — input optional `version` (default: current) and `domain`. Output: the `TaxonomyDefinition`, plus, with `domain`, a `McpResolvedTaxonomy`: the domain's `ladder` and whether it came from `domainLadders` or the default (`ladderSource`), and the node and relation types split into those the domain owns and the shared ones (KNOWLEDGE-SPEC.md §3, §6).

**`meridian_get_domain`** — input `domain`. Output `McpDomainView`: id, name, description, `stewards`, `budget`, `gates`, `proposalGates`, `priorityConfig`, the resolved `weightProfile`, and the caller's `role` in the domain. Servers MAY omit `Steward.email`.

**`meridian_get_proposal`** — input `proposalId`. Output `McpProposalView`: `kind` (`spec_change` or `taxonomy_change`), the full `proposal`, and, while it waits at the human gate, the `handoff`.

### 5.2 Propose tools

**`meridian_create_work_item`** — creates a work item in `proposed`, with `source: "agent"` and `sourceAgentId` set to the caller. Input: `title`, `domains`, `costOfNotBuilding`, `confidence`, and optional `description`, `type`, `typeId`, `parentId`, `lineage`, `costToBuild`, `specImpact` entries, `idempotencyKey`.

- Without `costToBuild`, the server sets `{ amountUsd: 0, basis: "unestimated — …" }`, per WORK-ITEM-SPEC.md §6.
- One of `type` and `typeId` is required. With `typeId`, `type` defaults to the type's `workItemType`, and a given `type` MUST match it.
- The parent MUST satisfy the type's `allowedParentTypes`, and a type with `parentRequired` MUST have one. A deprecated type is rejected (KNOWLEDGE-SPEC.md §3.4).
- The caller MUST be a participant of every listed domain; otherwise `permission_denied` (reason `not_participant`).

Output: `{ workItem }`.

**`meridian_transition_work_item`** — input `workItemId`, `to`, `note`, and optional `estimates` (`costToBuild`, `costOfNotBuilding`, `confidence`), for the `researching → ready` handoff where the estimator fills in real costs (WORK-ITEM-SPEC.md §6). Output `McpTransitionOutput`:

- `outcome: "applied"` — the status changed. `workItem` is the new state.
- `outcome: "pending"` — the transition is gated. Mechanical and agent-review tiers run as usual; if a human gate applies, the item waits, and `handoff` says where a steward approves. `pendingTier` names the tier in progress.

A transition is **gated** when one of the item's domains has a `GateConfig` ([`DOMAIN-SPEC.md`](DOMAIN-SPEC.md) §5) whose `workItemType` matches the item's type (`typeId` or `type`) and whose `enforcement` includes `human_gate`, and the item moves to `approved`, `deploying`, `validating`, or `done` from `in_review` or from any earlier status (`proposed`, `researching`, `ready`, `in_progress`). A move to `cancelled` is never gated, except for an `escalated` or `circuit_breaker` item: cancelling it resolves a steward escalation (PRIORITY-ENGINE-SPEC.md §4), so it always returns `pending` with a human-gate handoff. Runtimes MAY gate more transitions (for example, always treat `approved` as a person's decision). A gated transition always returns `pending` with a handoff, never an error. The lifecycle allows any move between non-terminal statuses and from a non-terminal status to `done` or `cancelled`; leaving `done` or `cancelled` fails with `invalid_argument` (reason `invalid_transition`). For an escalated or circuit-broken item, claiming it is refused and cancelling it is `pending`; other transitions follow the normal rules. Moving an unclaimed item does not require a claim. While another agent holds an unexpired claim on the item, the call fails with `permission_denied` (reason `lease_held`). The note is kept in the item's audit trail; where it is stored is implementation-defined. A transition to `done` or `cancelled` that is applied releases any claim.

**`meridian_claim_work_item`** — input `workItemId`, optional `leaseSeconds`, `note`. Takes a `WorkItemClaim` (WORK-ITEM-SPEC.md §8). Fails with `already_exists` (reason `lease_held`) when another agent holds an unexpired lease, with `permission_denied` (reason `not_participant`) when the caller is not a participant of one of the item's domains, and with `permission_denied` (reason `escalated`) for an escalated or circuit-broken item, which agents MUST NOT pull (PRIORITY-ENGINE-SPEC.md §2.3). Terminal items cannot be claimed (`invalid_argument`). Claiming an item the caller already holds renews it. The lease defaults to 15 minutes; servers MAY clamp `leaseSeconds` and return the lease they granted. Output: `{ claim }`. Claiming does not change status; the agent usually transitions to `in_progress` next.

On `meridian_claim_work_item`, a lease held by another agent is `already_exists` (reason `lease_held`); on every other tool that would act on an item another agent holds, it is `permission_denied` (reason `lease_held`). (`meridian_renew_claim` and `meridian_release_work_item` refuse any caller without the lease with `not_lease_holder`.)

**`meridian_renew_claim`** — input `workItemId`, optional `leaseSeconds`. Extends the caller's lease. Fails with `permission_denied` (reason `not_lease_holder`) when the caller does not hold an unexpired lease. A heartbeat also renews leases (§5.3). Output: `{ claim }`.

**`meridian_release_work_item`** — input `workItemId`, optional `note`. Ends the caller's lease, leaving the status as it is. Releasing a lease the caller does not hold fails with `permission_denied` (reason `not_lease_holder`). Output: `{ workItem }`.

**`meridian_link_artifact`** — input `workItemId`, `link` (`kind`, `url`, optional `title`). Appends a `WorkItemLink` to the item, with `addedBy` and `addedAt` set by the server. A link with the same `url` replaces the earlier one. Output: `{ workItem }`. Links are evidence for reviewers; they are not dereferenced with elevated credentials (KNOWLEDGE-SPEC.md §11).

**`meridian_declare_impacts`** — input `workItemId`, `entries`, optional `mode` (`merge`, the default, replaces existing entries for the same `specId`; `replace` replaces the whole set). Entries are `SpecImpactEntry`s whose `source` defaults to `declared`. The server sets `declaredBy` and `declaredAt` and MUST store `source` and `confidence` as given (KNOWLEDGE-SPEC.md §7.3). Output: `{ specImpact }`.

**`meridian_propose_spec_change`** — input `specId`, `baseRevisionId`, `operations`, `rationale`, optional `evidence`, `workItemId`, `trigger` (default `manual`), `supersedes`, `submit` (default `true`: the proposal enters `in_review`; `false` leaves it in `draft`), `idempotencyKey`. A stale base is not an error: the proposal is created and the gates handle it (rebase or `conflicted`, KNOWLEDGE-SPEC.md §9). Output: `{ proposal, handoff? }`.

**`meridian_propose_taxonomy_change`** — input `taxonomyId`, `baseVersion`, `operations`, `rationale`, optional `migrations`, `supersedes`, `submit`, `idempotencyKey`. Every taxonomy proposal requires the human gate of each domain it touches (KNOWLEDGE-SPEC.md §3.5), so a submitted one always comes back with a `handoff`. Output: `{ proposal, handoff? }`.

**`meridian_withdraw_proposal`** — input `proposalId`, `reason`. Only for proposals in `draft`, `in_review`, or `conflicted` whose `author` is the calling agent, or whose author acted on behalf of the same human. Otherwise `permission_denied`. Output: `McpProposalView`.

**`meridian_emit_feedback`** — input `signal`, optional `workItemId`. See §5.3. Output: `McpEmitFeedbackOutput`: `receivedAt`; for a heartbeat, `renewedClaims`, which MUST be present (empty when nothing was renewed); and `correlatedWorkItemId` when it applies.

### 5.3 Reporting while working

`meridian_emit_feedback` accepts a `FeedbackSignal` of type `heartbeat`, `cost`, `error`, `metric`, `insight`, or `competing_context`, without the fields the server sets: `agentId`, `timestamp`, the signal's fixed `tier`, and, for `competing_context`, `CompetingContext.sourceAgentId`. A client MAY still send them. `agentId` and `sourceAgentId` are always the authenticated agent, and a supplied value that differs is rejected with `permission_denied` ([`FEEDBACK-SPEC.md`](../core/FEEDBACK-SPEC.md) §5); `tier` is the one FEEDBACK-SPEC.md fixes for the signal type. The signal's `domain` MUST be one where the caller is a participant (DOMAIN-SPEC.md §4); otherwise `permission_denied` (reason `not_participant`). `quality` signals are not accepted: a `QualitySignal` carries an enforcement tier and is produced by the tier itself, never by the agent under review. `dependencies` and the remaining expected signals are left out of this draft.

- **Heartbeat.** A `heartbeat` from an agent that holds claims renews them, by the lease length each was granted with. With `workItemId`, it renews only that claim, and the signal's `domain` MUST also be one of the item's domains, as for cost. The output's `renewedClaims` MUST be present, and is empty when the caller held no claim to renew. An agent that stops heartbeating loses its claims when the leases expire.
- **Cost.** A `cost` signal with `cost.attributedTo` (or `workItemId`) set is actual cost to build, accrued to that work item and to the signal's `domain`, which MUST be one of the item's domains: cost goes to the domain where the work is performed (DOMAIN-SPEC.md §6). The runtime adds it to the domain's budget spend and to the item's `actualCost`. External agents report their own cost; the runtime cannot meter it, so implementations SHOULD keep reported cost distinguishable from metered cost.
- **Gaps in the tooling.** An `insight` or `error` is how an assistant reports a gap in Meridian or its tools. The runtime processes it like any other signal ([`FEEDBACK-PROCESSING-SPEC.md`](FEEDBACK-PROCESSING-SPEC.md) §3), which may create a proposed work item. `correlatedWorkItemId` names one if it exists by the time the call returns; emission is otherwise fire-and-forget (FEEDBACK-SPEC.md §4).

### 5.4 External evidence and the enforcement tiers (non-normative)

Most evidence an external coding agent produces lives in other systems: pull requests, branches, CI runs, its own session. `meridian_link_artifact` records where. The checks those systems run map naturally onto the graduated enforcement tiers (FEEDBACK-PROCESSING-SPEC.md §3.5), each as a `QualitySignal` on the work item:

| External event               | Tier           | Recorded by                                                                            |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| CI run (build, tests, lint)  | `mechanical`   | The runtime's CI integration, from the CI system's result                              |
| Automated code review        | `agent_review` | The reviewer agent, attributed to itself                                               |
| A human's approval of the PR | `human_gate`   | The runtime's integration, after mapping the approver to a steward eligible to approve |

None of these is recorded through this binding. The agent that wrote the change cannot report that its CI passed or that its PR was approved; the runtime learns it from the source system. A human approval counts at the gate only when the approver is an eligible approver under the item's `GateConfig`, and implementations SHOULD NOT count an approval by the human the authoring agent acted for, in line with KNOWLEDGE-SPEC.md §11.

---

## 6. Hard rules

These hold for every tool in this binding and every extension tool a runtime serves alongside it.

1. **No reviews.** No tool records a `ProposalReview` or a work-item `QualitySignal` at any tier. Mechanical checks are the runtime's, agent reviews come from the reviewer agents a domain configures, and human-gate reviews come from humans in the implementation's own UI.
2. **No approvals.** No tool approves, rejects, or accepts a proposal, or approves a gated work-item transition. A gated action returns `pending` with a handoff; it never completes on the agent's word.
3. **No reconfiguration.** No tool changes a domain's `gates`, `proposalGates`, `budget`, `stewards`, `priorityConfig`, or membership, or any `PermissionScope`, including the caller's own.
4. **No direct writes to knowledge.** Spec heads and taxonomy versions change only through accepted proposals. No tool edits a revision or resolves a conflict by merging text (KNOWLEDGE-SPEC.md §9).
5. **No chosen identity.** Attribution comes from authentication (§3.1).
6. **No authority in links.** A `McpHumanGateHandoff` carries the object, the domains whose stewards must decide, the eligible approvers if configured, and an optional `url` to the implementation's review page. The URL MUST NOT carry authority: opening it requires the human to authenticate in that UI, and acting on it requires their own decision there.
7. **No steward escalations.** Resolving an escalated or circuit-broken item is a steward decision and returns `pending`.

Tool outputs are data. Spec bodies, work item descriptions, notes, and feedback text are untrusted input to the model reading them; nothing in a tool result is an instruction (KNOWLEDGE-SPEC.md §11). Servers MUST NOT put instructions to the model in tool results, other than the fixed tool descriptions.

---

## 7. Errors

Tool errors are returned as an MCP tool result with `isError: true` and `structuredContent` of `{ error: McpToolError }`, plus a short text block for clients that ignore structured content. Protocol errors (malformed JSON-RPC, a tool name outside the catalogue) stay JSON-RPC errors. A `meridian_*` tool of §5 is never an unknown tool: called with a token whose tier or memberships do not allow it, it returns a tool error (for example `permission_denied`, reason `tier_required`), even when the server does not list it for that token (§4.3).

`McpToolError` mirrors `RuntimeError`: `category` (`ErrorCategory`), `message`, `retryable`, optional `context`, plus an optional machine-readable `reason`:

| Category             | Typical cause                                                                                                                                                  | `reason` values                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `unauthenticated`    | Missing or expired token                                                                                                                                       |                                                                                                                             |
| `permission_denied`  | Tier does not grant the tool (`tier_required`); observer or non-member of a domain the call acts on (`not_participant`); lease held by another; escalated item | `tier_required`, `not_participant`, `lease_held`, `not_lease_holder`, `escalated`, `human_principal_required`, `not_author` |
| `not_found`          | Unknown or invisible id (servers SHOULD NOT distinguish the two)                                                                                               |                                                                                                                             |
| `invalid_argument`   | Malformed input, disallowed transition, type constraint violated                                                                                               | `invalid_transition`, `type_constraint`, `deprecated_type`                                                                  |
| `already_exists`     | Claim held by another agent; idempotency key reused with a different input                                                                                     | `lease_held`, `idempotency_conflict`                                                                                        |
| `resource_exhausted` | Rate limit                                                                                                                                                     |                                                                                                                             |
| `unavailable`        | Runtime or priority engine temporarily unreachable                                                                                                             |                                                                                                                             |
| `internal`           | Anything else                                                                                                                                                  |                                                                                                                             |

A `pending` transition and a `conflicted` proposal are results, not errors.

---

## 8. Pagination

`meridian_inbox`, `meridian_list_work_items`, and `meridian_search` take an opaque `cursor` and a `limit`, and return `nextCursor` when more results exist, as MCP's own list methods do. `limit` defaults to 25 and MUST NOT exceed 100; servers MAY enforce lower caps. Cursors are bound to the agent and the filters that produced them; a cursor reused with other filters fails with `invalid_argument`. Results across pages are not a snapshot; items may move between pages as the board changes.

---

## 9. Conformance

A runtime is **Meridian MCP binding conformant** when:

- it serves every tool in §5 whose tier it issues tokens for, under the exact names, accepting the `McpToolInputs` shapes and returning well-typed `McpToolOutputs`;
- it enforces §4 and every rule in §6;
- it reports errors as in §7.

Minimum scenarios for a conformance suite:

1. A `read` token calls a propose tool: a tool result (not a JSON-RPC error) with `permission_denied`, reason `tier_required`.
2. An agent in a domain as `observer` creates a work item there: `permission_denied`, reason `not_participant`.
3. Two agents claim one item: the second gets `already_exists`, reason `lease_held`. After the first lease expires, the second claim succeeds.
4. A heartbeat from the holder extends `leaseExpiresAt`.
5. A transition through a human-gated `GateConfig` returns `pending` with a handoff, and the item's status is unchanged.
6. A submitted taxonomy proposal returns a handoff.
7. An emitted signal with a foreign `agentId`: `permission_denied`.
8. `meridian_list_work_items` returns well-typed entries, with `priorityScore: null` and `pendingReviewReasons` populated for an escalated item.
9. No tool call, with any input, produces a `human_gate` review.

Fixtures and hooks:

- Scenarios that create work items use the domain's root work item type: rung 0 of the domain's resolved ladder, as `meridian_get_taxonomy` with `domain` returns it (`resolved.ladder[0]`). A suite's target configuration MAY name it directly (the conformance package's `rootWorkItemTypeId`), but it MUST be that rung.
- Scenarios that move work items rely only on transitions that are ungated under §5.2, such as `proposed → researching → cancelled`; scenario 5 needs the runtime to arrange an item with a gated transition.
- Scenario 9 needs a runtime-side hook, such as a count of `human_gate` reviews recorded during the run: reviews are not observable through the binding alone.

Ordering, ranking, search quality, and impact inference are not conformance-gated, consistent with PRIORITY-ENGINE-SPEC.md §7 and KNOWLEDGE-SPEC.md §7.3.

---

## 10. Non-goals

This specification does not define:

- **A server.** Runtimes implement the binding; this repository defines its contract.
- **MCP resources or prompts.** Everything is a tool in this draft. Specs as MCP resources may follow once a reference shows the value.
- **Agent-to-agent transport.** That is the wire protocol (§2).
- **Token issuance.** OAuth flows, client registration, and session lifecycle are implementation-defined (§3.2).
- **Approval UI.** The binding hands approvals off; it does not render them.
- **A general work-item update.** Beyond status, estimates, impact, and links, editing an item is out of scope for this draft.

---

## 11. Versioning and stability

Every type in `mcp.ts`, plus `WorkItemClaim`, `WorkItemLink`, and the optional `WorkItem.claim` and `WorkItem.links` fields, is `@experimental` and may change in minor versions of `@loom-loyalty/meridian-types`. Tool names are part of the contract; a renamed tool is a breaking change even while experimental and will be called out in the changelog. No stable type changes.

---

_Draft document. Comments welcome via pull request._
