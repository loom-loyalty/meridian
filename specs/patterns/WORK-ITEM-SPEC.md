# Meridian Work Item Schema Specification

**Version:** 1.0.0-draft.1
**Status:** Draft
**Date:** April 2026
**License:** CC BY 4.0

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document defines the Meridian work item schema: the four work item types (initiative, epic, story, task), the two cost estimates (cost-to-build + cost-of-not-building) denominated in USD, the required field set, and the lifecycle. Work items are an operating pattern; see the [`README.md`](README.md) in this directory for the core/patterns boundary.

---

## 1. Purpose

This specification defines the work item schema for Meridian systems. Work items are the units of work that flow through the system: initiatives, epics, stories, and tasks. Every work item carries two cost estimates in real dollars, enabling automated prioritization.

---

## 2. Work item types

Meridian defines four work item types in a hierarchy:

- **Initiative** — a high-level goal, single-domain or cross-domain. "Reduce infrastructure costs by 20%." "Improve onboarding conversion by 15%."
- **Epic** — a domain-scoped body of work derived from an initiative. An initiative may produce epics in multiple domains.
- **Story** — a unit of deliverable work within an epic. Stories are what agents and humans pull from the board.
- **Task** — a sub-unit of a story. Typically a single action: write a migration, run a test, review a change.

Implementations may define additional types. The four above are the required vocabulary.

---

## 3. Required fields

Every work item must carry:

**Two cost estimates.** This is the defining characteristic of Meridian work items.

- `costToBuild` — what it costs to do this work. Denominated in USD. Broken down into: tokens, compute, human hours, and any other measurable cost.
- `costOfNotBuilding` — what it costs to NOT do this work. Denominated in USD. Broken down into: revenue impact, risk exposure, and debt accumulation.

Both are real dollar values, not story points, t-shirt sizes, or Fibonacci numbers. Estimates may be rough, but they must be expressed in dollars so implementations can compare heterogeneous work items (see [`PRIORITY-ENGINE-SPEC.md`](PRIORITY-ENGINE-SPEC.md) for the data contract Meridian adopters converge on).

**Domain assignment.** Which domain(s) this work belongs to.

**Source.** Who or what created this work item: `human`, `agent`, or `feedback` (created automatically by the feedback processing system).

**Confidence.** A score between 0.0 and 1.0 indicating how confident the system is in the cost estimates. Low-confidence work items may require human review before entering the active queue.

**Lineage.** What feedback signal, insight, or parent work item spawned this one. Lineage enables tracing from a deployed index back to the hot query that triggered the story.

**Status.** Current state in the pipeline: `proposed`, `researching`, `ready`, `in_progress`, `in_review`, `approved`, `deploying`, `validating`, `done`, `cancelled`.

---

## 4. Priority scoring

Meridian does not prescribe a specific priority formula. It prescribes the data that must be present for any priority system to work: the two cost estimates, confidence, domain, and lineage. See [`PRIORITY-ENGINE-SPEC.md`](PRIORITY-ENGINE-SPEC.md) for the normative data contracts Meridian adopters share (escalation mechanism, query protocol, weight-profile shape) and for the Loom reference formula that ships in [`@loom-loyalty/meridian-priority-reference`](../../packages/priority-reference/). Other implementations may use the reference, override its weights via `WeightProfile`, or implement their own engine entirely.

The recommended approach is a WSJF-inspired formula:

```
Priority = (costOfNotBuilding + timeCriticality + riskReduction) × confidence / costToBuild
```

Where `timeCriticality` increases as items age in the queue (cost of delay accumulates over time). Implementations define their own scoring logic using these inputs.

---

## 5. Cost estimate structure

```typescript
interface CostEstimate {
  amountUsd: number;
  breakdown?: {
    tokens?: number;         // estimated token cost
    compute?: number;        // estimated compute cost
    humanHours?: number;     // estimated human time cost
    revenueImpact?: number;  // revenue at risk (costOfNotBuilding)
    riskExposure?: number;   // probability × impact (costOfNotBuilding)
    debtAccumulation?: number; // ongoing cost if deferred (costOfNotBuilding)
  };
  basis?: string;              // human-readable explanation of methodology
  providedBy?: DomainId;       // domain accountable for this estimate
  estimatorAgentId?: AgentId;  // specific agent that produced the estimate
  estimatedAt?: Timestamp;     // when the estimate was produced
}
```

The `basis` field is important for auditability. "Estimated from similar past stories" or "Calculated from current query cost × projected traffic" gives humans and the compound learning layer context for how reliable the estimate is.

The `providedBy`, `estimatorAgentId`, and `estimatedAt` fields support the detector/estimator handoff (§6) and compound learning:

- `providedBy` — the domain accountable for the estimate. On `costOfNotBuilding` this is typically the detecting domain (the domain that observes the impact of not building). On `costToBuild` this is typically the executing domain (the domain that will bear the work). The two cost estimates on a single work item often carry different `providedBy` values.
- `estimatorAgentId` — the specific agent or reviewer that produced the estimate. Lets systems weight estimates by the estimator's historical accuracy.
- `estimatedAt` — lets downstream consumers detect stale estimates and trigger re-estimation when underlying conditions change.

When an estimate is revised during the work item lifecycle, implementations MAY overwrite the existing `CostEstimate` or retain prior estimates via observability logs. The spec does not mandate a revision history on the work item itself.

---

## 6. Cross-domain cost estimation (detector/estimator handoff)

Meridian separates the **detector** (the agent or human that notices a problem) from the **estimator** (the agent or human that knows what the work costs to build). An infrastructure monitoring agent can estimate the cost of NOT fixing a hot query — that's its observation surface. It cannot estimate the engineering cost of the migration; that's engineering-domain information.

The work item lifecycle encodes this handoff:

- **`proposed`** — the detector creates the work item and populates `costOfNotBuilding` (and any domain-local context it has). `costToBuild` is typically unestimated at this stage. When unestimated, set `costToBuild.amountUsd` to `0` and `costToBuild.basis` to a string starting with `"unestimated"` (e.g. `"unestimated — engineering to provide"`), so the reason is auditable. Status is the normative signal, not the basis string: **priority engines MUST exclude work items in `proposed` status from priority queries**, since their `costToBuild` is not yet trustworthy.
- **`researching`** — the executing domain (engineering, design, security, etc.) takes the work item and estimates `costToBuild` with a substantive `basis` string. The work item may cross multiple domains during this phase if the work is complex.
- **`ready`** — both costs are populated with real estimates and real basis strings. Priority engines consider the item from this status forward.
- **`in_progress` onward** — implementation, review, deploy, validation.

Work items may be enhanced at any point during their lifecycle — with a new `CompetingContext`, with a revised cost estimate, with additional risk notes — not just during `researching`. The `lineage` field tracks enhancement chains when one work item supersedes another.

A work item that never finds an estimator can stay in `proposed` indefinitely or transition to `cancelled`; the spec does not set a timeout.

---

## 7. Work item lifecycle

Work items move through statuses. Transitions are driven by agents, humans, or the feedback system:

```
proposed → researching → ready → in_progress → in_review → approved → deploying → validating → done
                                                                                            ↗
                                                                               cancelled ←──┘
```

Not every work item passes through every status. A simple task may go directly from `ready` to `in_progress` to `done`. An initiative may spend weeks in `researching`.

The `in_review` status triggers graduated enforcement: mechanical checks first, then agent review, then human gates (as defined in the Feedback Processing Spec).

---

*Draft document. Comments welcome via pull request.*
