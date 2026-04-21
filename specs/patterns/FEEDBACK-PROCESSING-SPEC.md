# Meridian Feedback Processing Specification

**Version:** 1.0.0-draft.2
**Status:** Draft
**Date:** April 2026
**License:** CC BY 4.0

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document defines the optional-tier feedback signal types and the processing mechanisms that transform feedback into work items, healing actions, and learning. The envelope and required + expected tiers live in [`../core/FEEDBACK-SPEC.md`](../core/FEEDBACK-SPEC.md).

---

## 1. Purpose

Raw feedback is useless if it piles up. This spec defines (a) the optional-tier signal types that make the system smarter over time, and (b) the five mechanisms that transform feedback into work items, healing actions, and learning.

---

## 2. Optional-tier signal types

Components that emit these make the system more intelligent over time. None of them are required for baseline Meridian conformance, but adopters who invest in them get the compound-learning benefit.

### 2.1 Quality signals

Structured validation results with individual check outcomes, scores, and fix suggestions. A quality signal carries:

- `result` — `pass`, `fail`, or `warn`
- `category` — `architectural`, `behavioral`, `performance`, `security`, `documentation`, `testing`, `entropy`, `custom`
- Individual `QualityCheck` results with an auto-fixability flag
- Which enforcement tier (`mechanical`, `agent_review`, `human_gate`) produced the result

See `@loom-loyalty/meridian-types` for the full shape.

### 2.2 User and stakeholder impact

Who does this affect? How many users? Which customers? What revenue is attached?

### 2.3 Competing context

Machine-readable counter-evidence emitted when a proposed change would affect a component. Carries a structured impact assessment:

- `concern` — one of: `dependency_risk`, `sla_risk`, `cost_risk`, `data_risk`, `performance_risk`, `security_risk`, `architectural_risk`, `custom`
- `impact.affectedConsumers` — consumer count
- `impact.revenueAtRiskUsd` — revenue at risk
- `impact.blastRadius` — `isolated`, `module`, `service`, `domain`, or `system`
- `impact.breakingDependencies` — dependencies that would break
- `argument` — human-readable claim
- `suggestedAlternative` — optional alternative approach
- `confidence` — 0.0 to 1.0

Competing context is machine-readable so downstream consumers (including the priority engine; see [`PRIORITY-ENGINE-SPEC.md`](PRIORITY-ENGINE-SPEC.md)) can factor it into decisions. [`PRIORITY-ENGINE-SPEC.md`](PRIORITY-ENGINE-SPEC.md) §4 defines the normative escalation mechanism for contexts whose `blastRadius` exceeds `module`.

### 2.4 Pattern recognition

"This is the third time this week I've seen this failure pattern." "This type of change has caused regressions 4 out of 5 times." Pattern recognition signals feed the meta-loop (see §4) and the regression annotation in the priority engine.

---

## 3. The five processing mechanisms

### 3.1 Routing

Every feedback signal carries routing metadata:

- **Domain targeting:** which domain should see this signal
- **Urgency:** `act_now`, `act_soon`, `informational`
- **Actionability:** `actionable` (can create work) or `context_only` (enriches existing work)

Routing rules are configurable per domain. A payment system error routes to the Revenue domain steward. A UX insight routes to the User Experience domain. A cost anomaly routes to whoever owns the budget.

### 3.2 Conflict resolution

Components disagree. One agent says "this query is fine, it's the application code." Another says "this query is the bottleneck." Both provide evidence.

The system does not pick a winner. It surfaces both perspectives with evidence using the `CompetingContext` format (defined in §2.3). The `CompetingContext` type is machine-readable: concern type, affected consumer count, revenue at risk, blast radius, breaking dependencies, confidence score. This enables implementations to factor competing perspectives into scoring. The normative escalation mechanism when `blastRadius` exceeds `module` is defined in [`PRIORITY-ENGINE-SPEC.md`](PRIORITY-ENGINE-SPEC.md) §4.

For conflicts above a configurable severity threshold, the system escalates to a human steward. For lower-severity conflicts, the system uses confidence scores to weight perspectives and records the resolution for future learning.

### 3.3 Deduplication

Multiple agents noticing the same issue should not create multiple work items. The system correlates related feedback signals and creates one work item with all contributing evidence attached.

Correlation uses:

- Temporal proximity (signals within a configurable window)
- Source overlap (signals about the same component or work item)
- Content similarity (signals with matching categories and similar messages)

The deduplication window and similarity thresholds are configurable per domain.

### 3.4 Cooldown

If a work item was recently closed for an issue, the system does not immediately recreate it. A configurable suppression window prevents feedback churn.

If the issue recurs after the cooldown period, the system creates a new work item referencing the previous one and flags it as a regression. Regressions receive a priority boost because they indicate the previous fix was insufficient.

### 3.5 Graduated enforcement

Work passes through up to three validation tiers before completion:

**Mechanical (tier 1).** Lint rules, structural tests, schema validation, dependency checks. Automated, deterministic, no human involvement required. A work item that fails mechanical checks is either auto-fixed (if the failure is `autoFixable`) or blocked with a clear error.

**Agent review (tier 2).** Specialized reviewer agents assess quality. Automated but non-deterministic. A code review agent checks for performance anti-patterns. An architecture agent validates layer boundaries. A security agent scans for vulnerabilities. Each reviewer emits a `QualitySignal` with individual check results.

**Human gate (tier 3).** Steward approval for changes that pass mechanical and agent review but require human judgment. Architecture decisions. Customer-facing changes. Budget impact above a threshold.

Not every work item passes through all three tiers. Domain stewards configure which tiers apply to which work item types via `GateConfig` (defined in [`DOMAIN-SPEC.md`](DOMAIN-SPEC.md)). The goal: most work resolves at tier 1 or 2 and never needs a human.

---

## 4. Feedback-on-feedback

When the system acts on feedback (creates a work item, auto-heals, changes a priority score), the outcome of that action is tracked separately.

- Which auto-created work items actually got worked?
- Which self-healing actions resolved the issue versus masked it?
- Which priority changes led to better outcomes?

Over time, this meta-loop improves the system's ability to decide what work to do, not just how to do it.

---

## 5. Decision tree: feedback to action

```
Feedback arrives
  │
  ├─ Is this a known issue with a known fix?
  │   └─ YES → Auto-heal. Execute the fix. Emit quality signal on outcome.
  │
  ├─ Is this a known issue without an automated fix?
  │   └─ YES → Create work item with diagnostic context and cost estimates.
  │             Route to the appropriate domain board.
  │
  ├─ Is this a novel issue?
  │   └─ YES → Create high-priority work item with all telemetry attached.
  │             Flag for steward review if severity warrants.
  │
  └─ Is this a recurring issue that was previously auto-healed?
      └─ YES → Create improvement initiative targeting root cause.
               The auto-heal is treating symptoms; this addresses the disease.
```

---

_Draft document. Comments welcome via pull request._
