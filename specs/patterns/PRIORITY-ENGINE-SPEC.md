# Meridian Priority Engine Specification

**Version:** 1.0.0-draft.1
**Status:** Draft
**Date:** April 2026
**License:** CC BY 4.0

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document defines what it means to be a Meridian priority engine: the data shapes implementations agree on, the escalation mechanism that must fire for high-blast-radius competing claims, the wire protocol for agent queries, and the conformance bar. Priority scoring itself — formulas, weight values, tie-break rules — is **not** prescribed here. A reference implementation of one such scoring shape ships in [`@loom-loyalty/meridian-priority-reference`](../../packages/priority-reference/); the non-normative "Implementation Guidance" section at the end documents what that reference does and why.

---

## 1. Purpose and non-goals

A priority engine answers one question: given the open work items visible to a domain, which ones should agents pull next? Meridian commits to the **shapes** of that answer (so agents written against one runtime can query another) and to the **escalation path** for contested decisions (so high-stakes calls don't silently settle in a formula). It does not commit to a specific formula or set of weights, because those are taste-level decisions every organization tunes to its own ops model.

### What this spec normatively defines

- Data types for priority configuration (`WeightProfile`, `DomainPriorityConfig`, `CircuitBreakerConfig`), query payloads (`AgentPriorityQuery`, `AgentPriorityResponse`), and the extension point (`PriorityLearner`). All defined in `@loom-loyalty/meridian-types/work-item`.
- The escalation mechanism for `CompetingContext` whose `impact.blastRadius` exceeds `module`.
- The addressing convention for priority engines (`"__priority__"` well-known recipient).
- Wire protocol message types `PRIORITY_QUERY` (`0x40`) and `PRIORITY_RESPONSE` (`0x41`).
- Conformance criteria: response-shape validation only. Implementations that produce different orderings for identical inputs are both conformant as long as their response payloads are well-typed.

### What this spec explicitly does NOT define

- A priority formula, or weight values, or scoring constants. Adopt the reference, tune its weights via `WeightProfile`, or write your own engine — all three are conformant.
- A tie-break rule for equal priority scores. Implementation's choice.
- The lifecycle of a `"__priority__"` endpoint (spawn timing, restart semantics, replication). Runtime's choice.
- Cross-implementation ordering conformance. Two conformant engines MAY rank the same inputs differently.

> `[NATE: consider whether the last bullet in §1 is clearly stated. The principle — data contracts yes, scoring algorithms no — is the most important positioning move in this whole spec. Worth an extra sentence of editorial voice here.]`

---

## 2. Data shapes (normative)

All data contracts are in `@loom-loyalty/meridian-types/work-item`. This section documents the contract; the types package is the source of truth.

### 2.1 WeightProfile

```typescript
interface WeightProfile {
  id: string;
  costOfNotBuildingWeight?: number;      // default 1.0
  timeCriticalityWeight?: number;         // default 1.0
  impactWeight?: number;                  // default 1.0
  confidenceMultiplier?: number;          // default 1.0
  usdPerAffectedConsumer?: number;        // default 1.0
  usdPerDayWeight?: number;               // default 1.0
  regressionMultiplierCap?: number;       // default 2.0
  timeCriticalityCap?: number;            // default 2.0
}
```

Implementations MAY ignore any or all numeric fields and compute priorities however they see fit. The spec defines a default profile whose `id` is `"default"` and whose numeric fields take the values shown above. Implementations MUST support `WeightProfile` at the interface level (accept it on config, emit it in debug output) even if their scoring ignores it.

### 2.2 DomainPriorityConfig and CircuitBreakerConfig

```typescript
interface DomainPriorityConfig {
  weightProfileId?: string;               // falls back to "default"
  circuitBreakerConfig?: CircuitBreakerConfig;
}

interface CircuitBreakerConfig {
  criticalSeverityThreshold: "critical" | "high";
  bypassBlastRadius: ErrorFeedback["blastRadius"][];  // note: different enum from CompetingContext.blastRadius
  requireRecoveredFalse: boolean;
  escalationPath: "steward" | "runtime_log_only";
}
```

`DomainPriorityConfig` is stored on `Domain` objects (see [`DOMAIN-SPEC.md`](DOMAIN-SPEC.md) §3) so stewards can tune per-domain. When absent, implementations behave as if `weightProfileId: "default"` and the default circuit-breaker trigger (see §3) apply.

### 2.3 AgentPriorityQuery and AgentPriorityResponse

See the type package for the full shape. The response's `priorityScore` field is `number | null`; `null` means the item escalated (see §3) and is not eligible for agents to pull. `explanation` is a one-line string; format is non-normative but `[NATE: suggest a canonical format in the Implementation Guidance section — this is what readers will copy verbatim]`.

### 2.4 PriorityLearner (experimental)

`PriorityLearner` is an extension point for implementations that learn priority weights from outcomes. It is marked `@experimental` in v1.0 and the shape may stabilize in v1.1 once enough implementations exercise it. Non-default learners produce different outputs than the reference, which is allowed by design.

---

## 3. Circuit breaker (normative)

The circuit breaker is the path an `ErrorFeedback` signal takes when something is so bad the priority engine should not be in the decision loop. When a fresh `ErrorFeedback` signal on a work item or agent matches **all** of the following, the engine MUST bypass normal scoring:

```
severity matches DomainPriorityConfig.circuitBreakerConfig.criticalSeverityThreshold
  (default "critical") with severity levels considered ordered
  critical > high > medium > low, so `"high"` threshold accepts "critical"
  and "high"

blastRadius ∈ DomainPriorityConfig.circuitBreakerConfig.bypassBlastRadius
  (default ["all_customers"])

when requireRecoveredFalse is true (default):
  recovered === false
```

On trigger, the engine MUST:

1. Return `priorityScore: null` for the affected work item in any response.
2. Attach a `PriorityAnnotation: "circuit_breaker"` to the item.
3. Emit a `FeedbackSignal` of tier `"required"` naming the domain steward.
4. Write an observability event capturing the full trigger context (the triggering `ErrorFeedback`, the `DomainPriorityConfig` that matched, timestamp).

Note that `ErrorFeedback.blastRadius` and `CompetingContext.impact.blastRadius` are **different enums** with different vocabularies. The circuit breaker consumes the former; the escalation mechanism in §4 consumes the latter. Conflating them is a common implementation mistake.

> `[NATE: the three-part AND trigger may be too strict. Consider whether "first" frequency should also trigger, or whether recurring/escalating ones are the right focus. Gut check against what you've seen at Loom.]`

---

## 4. Escalation mechanism (normative)

When one or more `CompetingContext` objects attached to a work item have `impact.blastRadius ∈ {"service", "domain", "system"}`, the engine MUST:

1. Return `priorityScore: null` for that item in any response.
2. Surface all attached `CompetingContext` objects in `AgentPriorityResponse.pendingReviewReasons`.
3. Attach `PriorityAnnotation: "escalated"` to the item.
4. Route a `FeedbackSignal` of tier `"required"` to the domain steward via the runtime's feedback transport.
5. Exclude the work item from subsequent `PRIORITY_QUERY` responses until a steward resolves the state (by marking contexts resolved, lowering their blast radius, or transitioning the work item to `cancelled`).

**Blast radii below `service`** (i.e., `isolated` and `module`) are **not** normatively escalated. Implementations MAY auto-factor them into score, surface them to humans, or ignore them. The reference implementation auto-factors below `module`; see Implementation Guidance.

**Low-confidence high-blast-radius claim:** A `CompetingContext` with `confidence: 0.1` and `blastRadius: "system"` still triggers escalation. Blast radius wins; the steward sees the confidence value and decides whether to trust the claim. This rule is normative because the opposite choice — "low-confidence escalations don't fire" — opens a denial-of-escalation attack: an adversarial agent could suppress escalation by emitting a flurry of low-confidence high-blast-radius claims.

**Aggregation when multiple `CompetingContext` attach to one work item:**

- If **any** has `blastRadius ∈ {"service", "domain", "system"}`: escalate. Do not aggregate.
- Otherwise (all are `isolated` or `module`): aggregation is implementation-defined. The reference implementation sums `revenueAtRiskUsd`, sums `affectedConsumers`, takes `max(blastRadius)` (where `module > isolated`), and uses a revenue-weighted mean of `confidence`.

### Security: `CompetingContext.sourceAgentId`

Runtimes MUST validate that `CompetingContext.sourceAgentId` matches the authenticated agent that emitted the signal; invalid contexts MUST be rejected with `PERMISSION_DENIED`. Priority engines MAY additionally reject contexts whose `sourceAgentId` has not been runtime-validated, but this is **not sufficient** as the sole enforcement point — if the runtime accepts a spoofed context into storage, the engine has already trusted it by the time it sees it. See [`../core/FEEDBACK-SPEC.md`](../core/FEEDBACK-SPEC.md) §5.

---

## 5. Addressing and lifecycle

The priority engine is addressable as the well-known agent id string `"__priority__"`, scoped by the frame header's `domain` field. A runtime routes any frame whose `to === "__priority__"` to the priority engine instance serving the sender's domain.

The lifecycle of a `"__priority__"` endpoint is **implementation-defined**. Runtimes MAY spawn eagerly on domain creation, lazily on first query, as a singleton across the process, or as a per-domain Durable Object. Agents that receive `NOT_FOUND` when querying `"__priority__"` MAY treat it as a temporary failure (retry with backoff) or terminal (the runtime does not host a priority engine).

No runtime primitive is added by this spec. Priority engines are ordinary agents from the runtime's point of view, addressable at the well-known id.

---

## 6. Wire protocol

The priority engine uses two message types from [`../core/WIRE-PROTOCOL-SPEC.md`](../core/WIRE-PROTOCOL-SPEC.md) §5.3:

| Value | Name | Description |
|---|---|---|
| `0x40` | `PRIORITY_QUERY` | Agent → engine query |
| `0x41` | `PRIORITY_RESPONSE` | Engine → agent response |

Payloads are MessagePack-encoded `AgentPriorityQuery` and `AgentPriorityResponse` respectively, defined in `@loom-loyalty/meridian-types/work-item`. The response MUST set the frame header's `cor` field to the originating query's `id` for correlation.

The `limit` field on `AgentPriorityQuery` defaults to 1 and MUST NOT exceed 10; implementations MAY enforce lower caps. `includeExplanation` defaults to `true`; when `false`, implementations MAY omit `explanation` strings in the response.

---

## 7. Conformance

An implementation is **Meridian Priority Engine v1.0 conformant** when, for any well-formed `AgentPriorityQuery`, it returns a well-typed `AgentPriorityResponse` with:

- `items` populated with `PrioritizedWorkItem` objects whose `workItem`, `priorityScore`, and `explanation` fields are present and correctly typed.
- `priorityScore: null` for any item whose state matches the escalation mechanism (§4) or the circuit breaker (§3).
- `pendingReviewReasons` populated when the response includes any escalated items.
- `queriedAt` set to a monotonic timestamp.

**Ordering is not conformance-gated.** Two conformant engines MAY produce different top-N orderings for identical inputs. The conformance test suite in [`../../packages/conformance/src/priority/`](../../packages/conformance/src/priority/) validates response shape only.

Scenarios covered by the conformance suite:

1. Basic query returning a non-empty items list
2. Query against an empty work queue (empty `items`)
3. Query against a work item with an escalating `CompetingContext` (expect `priorityScore: null` + `pendingReviewReasons` populated)
4. Query against an unknown domain (expect `NOT_FOUND`)
5. Query with malformed payload (expect `INVALID_ARGUMENT`)

Implementations MAY add more scenarios; the listed five are the minimum for conformance.

---

## 8. Implementation Guidance (non-normative)

This section documents Loom's reference implementation shipping in [`@loom-loyalty/meridian-priority-reference`](../../packages/priority-reference/). It is **non-normative**. Other implementations are free to diverge from any or all of it. Weight profiles, formulas, recomputation policies, and tie-break rules are **not** conformance criteria.

### 8.1 WSJF-derived reference formula

```
base = ( costOfNotBuilding.amountUsd
       + timeCriticality
       + riskReduction )
       × (1 + impact × impactWeight)
       × confidence × confidenceMultiplier
       / max(costToBuild.amountUsd, 0.01)

priority = base × regressionMultiplier
```

Where:

```
riskReduction         = costOfNotBuilding.breakdown?.riskExposure ?? 0
confidence            = WorkItem.confidence                              // 0.0-1.0

severityWeight        = { critical: 4, high: 2, medium: 1, low: 0.5 }
frequencyWeight       = { first: 1, recurring: 1.5, escalating: 3 }
ageDays               = (now - WorkItem.createdAt) / 86_400_000

timeCriticalityRaw    = ageDays × severityWeight × frequencyWeight × usdPerDayWeight
timeCriticality       = min(timeCriticalityRaw, costOfNotBuilding.amountUsd × timeCriticalityCap)

impactFromRevenue     = correlatedCompetingContext?.impact.revenueAtRiskUsd ?? 0
impactFromConsumers   = (correlatedCompetingContext?.impact.affectedConsumers ?? 0)
                         × usdPerAffectedConsumer
impact                = (impactFromRevenue + impactFromConsumers)
                         / max(costOfNotBuilding.amountUsd, 0.01)
                         // impact is unitless here to avoid double-counting
                         // revenue with costOfNotBuilding

regressionMultiplier  = min(regressionMultiplierCap, 1 + 1 / daysSinceClosed)
                         when lineage.supersedes matches a closed item within cooldown;
                       = 1.0 otherwise
```

### 8.2 Rationale for the magic numbers

- `severityWeight` (4/2/1/0.5): geometric spread so critical errors dominate time-criticality by 8x over low-severity. Borrowed from common incident-severity heuristics at Loom.
- `frequencyWeight` (1/1.5/3): escalating errors should double the time-criticality of a first occurrence to surface recurrence to the steward without completely crowding out fresh critical work.
- `timeCriticalityCap` (2.0): prevents a stale item (high age × high severity) from exceeding 2x its own cost-of-not-building. Without the cap, a 100-day-old critical error would dwarf every other input.
- `regressionMultiplierCap` (2.0): same-day reopens cap at 2x priority. A work item reopened once, 10 days after closure, scores ~1.1x a non-regression peer.
- `usdPerAffectedConsumer` (1.0): $1 per affected user as a floor. Tune per-domain — Loom tunes this higher in the product domain than in infrastructure.

> `[NATE: the "8.2 Rationale" prose is the most important block in the non-normative section. Readers who care about formulas will check whether these numbers are defensible. Expand the Loom-specific context you have — why 4 for critical, not 5; why cap at 2.0, not 3.0. Your voice here carries more weight than the actual numbers.]`

### 8.3 Regression sensitivity

| Days since closed | Multiplier (default `regressionMultiplierCap` = 2.0) |
|---|---|
| 1 | 2.00 |
| 2 | 1.50 |
| 5 | 1.20 |
| 10 | 1.10 |
| 30 | 1.03 |

Regression boost only applies when the new item's `lineage.supersedes` points to a closed item within the domain's cooldown window (see [`FEEDBACK-PROCESSING-SPEC.md`](FEEDBACK-PROCESSING-SPEC.md) §3.4).

### 8.4 Tie-break and ordering (reference only)

The reference impl breaks ties by `createdAt` ascending, then `id` lexicographic ascending. This makes orderings deterministic for test fixtures but is not required by the spec. Implementations MAY break ties randomly, by domain priority, or by some other rule.

### 8.5 Priority recomputation policy

The reference impl recomputes priority scores when:

- A work item transitions from `proposed` → `researching` or from `researching` → `ready`.
- A new correlated `ErrorFeedback` or `CompetingContext` arrives for a work item in `proposed`, `researching`, or `ready` status.
- A new `QualitySignal` arrives for the agent that produced the item's cost estimates.

Work items in `in_progress` or later statuses have their priority frozen at selection time; the engine does not re-score them. Implementations MAY choose different policies.

### 8.6 Explainability `why` line format

The reference produces explanations in this shape, intended to be readable at a glance by a steward scanning a board:

```
#{rank} because {dominant-factor-summary}{ • optional-budget-annotation}
```

Examples:

```
#1 because revenue at risk $12k, blast module, 4 regressions this week, cost $50
#2 because drop rate 12%, affected users 4800, confidence 0.91
#3 because SLA risk module, 2 dependents pending • note: infra domain at 95% cap (budget reading 12min stale)
```

When the domain's `currentSpendUsd / monthlyLimitUsd` ratio exceeds 0.8, a budget annotation is appended after a bullet. When the budget reading is older than 60 seconds, a staleness warning appears in the annotation. Rankings are not modified by budget; this is an explainability-only affordance.

> `[NATE: the budget staleness convention is worth a Loom-specific note. Why 60 seconds? What's the cost-attribution pipeline timing you're expecting?]`

---

## 9. Versioning

This spec follows semantic versioning. The normative data shapes (§2) and escalation mechanism (§4) are frozen for the v1.x line; new fields may be added to payload types as optional in minor versions. Implementation Guidance (§8) is non-normative and may change freely.

---

## 10. Open questions

- **Q1: Should per-domain WeightProfile overrides be declared at domain-config time, or allowed to change at runtime?** A runtime change implies priority scores shift under agents, which could confuse stewards mid-decision. The reference implementation requires an explicit `setPriorityConfig` call and emits an observability event; the spec is silent on whether implementations must do this.
- **Q2: Should `DomainBudget.currentSpendUsd` staleness be part of the normative budget-annotation convention, or reference-only?** Currently reference-only. A normative threshold (e.g., "implementations MUST flag readings older than N seconds") would make explanations comparable across runtimes, but couples priority-engine explanations to a freshness contract in DOMAIN-SPEC that doesn't exist yet.
- **Q3: Should tie-break be normative for conformance?** Currently no. A normative tie-break rule would enable cross-implementation ordering match for the narrow case of identical scores, which is common in sparse work queues. Counter-argument: this is a performance/determinism question implementations will want latitude on.

---

*Draft document. Comments welcome via pull request.*