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

Both are real dollar values, not story points, t-shirt sizes, or Fibonacci numbers. Estimates may be rough, but they must be expressed in dollars so implementations can compare heterogeneous work items (see [`PRIORITY-ENGINE-SPEC.md`](PRIORITY-ENGINE-SPEC.md), landing in v1.0-draft.5, for the data contract Meridian adopters converge on).

**Domain assignment.** Which domain(s) this work belongs to.

**Source.** Who or what created this work item: `human`, `agent`, or `feedback` (created automatically by the feedback processing system).

**Confidence.** A score between 0.0 and 1.0 indicating how confident the system is in the cost estimates. Low-confidence work items may require human review before entering the active queue.

**Lineage.** What feedback signal, insight, or parent work item spawned this one. Lineage enables tracing from a deployed index back to the hot query that triggered the story.

**Status.** Current state in the pipeline: `proposed`, `researching`, `ready`, `in_progress`, `in_review`, `approved`, `deploying`, `validating`, `done`, `cancelled`.

---

## 4. Priority scoring

Meridian does not prescribe a specific priority formula. It prescribes the data that must be present for any priority system to work: the two cost estimates, confidence, domain, and lineage. See [`PRIORITY-ENGINE-SPEC.md`](PRIORITY-ENGINE-SPEC.md) (forthcoming v1.0-draft.5) for the normative data contracts Meridian adopters share (escalation mechanism, query protocol, weight-profile shape) and for the Loom reference formula that ships in [`@loom-loyalty/meridian-priority-reference`](../../packages/priority-reference/). Other implementations may use the reference, override its weights via `WeightProfile`, or implement their own engine entirely.

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
  basis?: string;  // human-readable explanation of estimate methodology
}
```

The `basis` field is important for auditability. "Estimated from similar past stories" or "Calculated from current query cost × projected traffic" gives humans and the compound learning layer context for how reliable the estimate is.

---

## 6. Work item lifecycle

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
