# Meridian Feedback Processing Specification

**Version:** 1.0.0-draft.1
**Status:** Draft
**Date:** April 2026
**License:** CC BY 4.0

---

## 1. Purpose

This specification defines how feedback signals (defined in the Feedback Contract Spec) are processed into actions. Raw feedback is useless if it piles up. This spec defines the five mechanisms that transform feedback into work items, healing actions, and learning.

---

## 2. The five processing mechanisms

### 2.1 Routing

Every feedback signal carries routing metadata:

- **Domain targeting:** which domain should see this signal
- **Urgency:** `act_now`, `act_soon`, `informational`
- **Actionability:** `actionable` (can create work) or `context_only` (enriches existing work)

Routing rules are configurable per domain. A payment system error routes to the Revenue domain steward. A UX insight routes to the User Experience domain. A cost anomaly routes to whoever owns the budget.

### 2.2 Conflict resolution

Components disagree. One agent says "this query is fine, it's the application code." Another says "this query is the bottleneck." Both provide evidence.

The system does not pick a winner. It surfaces both perspectives with evidence using the `CompetingContext` format (defined in the Feedback Contract Spec). The `CompetingContext` type is machine-readable: concern type, affected consumer count, revenue at risk, blast radius, breaking dependencies, confidence score. This enables the priority engine to automatically factor competing perspectives into scoring.

For conflicts above a configurable severity threshold, the system escalates to a human steward. For lower-severity conflicts, the system uses confidence scores to weight perspectives and records the resolution for future learning.

### 2.3 Deduplication

Multiple agents noticing the same issue should not create multiple work items. The system correlates related feedback signals and creates one work item with all contributing evidence attached.

Correlation uses:
- Temporal proximity (signals within a configurable window)
- Source overlap (signals about the same component or work item)
- Content similarity (signals with matching categories and similar messages)

The deduplication window and similarity thresholds are configurable per domain.

### 2.4 Cooldown

If a work item was recently closed for an issue, the system does not immediately recreate it. A configurable suppression window prevents feedback churn.

If the issue recurs after the cooldown period, the system creates a new work item referencing the previous one and flags it as a regression. Regressions receive a priority boost because they indicate the previous fix was insufficient.

### 2.5 Graduated enforcement

Work passes through up to three validation tiers before completion:

**Mechanical (tier 1).** Lint rules, structural tests, schema validation, dependency checks. Automated, deterministic, no human involvement required. A work item that fails mechanical checks is either auto-fixed (if the failure is `autoFixable`) or blocked with a clear error.

**Agent review (tier 2).** Specialized reviewer agents assess quality. Automated but non-deterministic. A code review agent checks for performance anti-patterns. An architecture agent validates layer boundaries. A security agent scans for vulnerabilities. Each reviewer emits a `QualitySignal` with individual check results.

**Human gate (tier 3).** Steward approval for changes that pass mechanical and agent review but require human judgment. Architecture decisions. Customer-facing changes. Budget impact above a threshold.

Not every work item passes through all three tiers. Domain stewards configure which tiers apply to which work item types via `GateConfig` (defined in the Domain Model Spec). The goal: most work resolves at tier 1 or 2 and never needs a human.

---

## 3. Feedback-on-feedback

When the system acts on feedback (creates a work item, auto-heals, changes a priority score), the outcome of that action is tracked separately.

- Which auto-created work items actually got worked?
- Which self-healing actions resolved the issue versus masked it?
- Which priority changes led to better outcomes?

Over time, this meta-loop improves the system's ability to decide what work to do, not just how to do it.

---

## 4. Decision tree: feedback to action

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

*Draft document. Comments welcome via pull request.*
