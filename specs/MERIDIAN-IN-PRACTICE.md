# Meridian in Practice

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document is the narrative companion to the formal specs in [`core/`](core/) and [`patterns/`](patterns/). Read this first. Every field value in the chapters below is a real Meridian type with a real value — nothing is pseudocode. The formal specs are the reference; this is the map.

---

## Opening scene

> **[NATE: opening scene prose — polish the voice.]** Draft seed: "Picture a loyalty company with eight people. Three of them are stewards. Five of them build. The rest of the operational work — reading query plans at 2am, watching funnel conversion drift, reconciling usage reports, filing support tickets about partner onboarding, catching the regression before the customer does — runs on domain agents. The agents work against real dollar budgets. The stewards set direction and gate decisions. The costs are visible in real time. That company is running lean on Meridian. Here's what that looks like in the code."

---

## Chapter 1: The Postgres Agent

This chapter follows a single domain agent through a full work cycle: spawn, baseline, detection, work item creation, graduated enforcement, steward approval, observability.

### Spawn

The Postgres monitoring agent enters Loom's `infrastructure` domain:

```typescript
import type { SpawnConfig } from "@loom-loyalty/meridian-types";

const config: SpawnConfig = {
  id: "pg-query-optimizer-prod",
  domain: "infrastructure",
  limits: {
    maxCostUsd: 50,             // monthly ceiling for this agent instance
    maxTokensTotal: 100000,
    maxTokensPerCall: 8000,
    maxMemoryMB: 128,
  },
  metadata: {
    target: "orders-db-prod",
    region: "us-east-1",
  },
};
```

The `infrastructure` domain has its own budget envelope on the `Domain` object (see [`patterns/DOMAIN-SPEC.md`](patterns/DOMAIN-SPEC.md)). That is a separate ceiling — budget is domain-level, `ResourceLimits` are agent-level. Both constrain; neither substitutes for the other.

### Baseline observation

The agent observes for 48 hours before surfacing anything. During observation, it stores query-cost baselines in its isolated state namespace using the `StatePersistence` primitive ([`core/RUNTIME-SPEC.md`](core/RUNTIME-SPEC.md) §4.2):

```typescript
await state.save(agentId, "baseline:query_fingerprints", { /* 47 fingerprints */ });
await state.save(agentId, "baseline:p95_ms", { SELECT_orders_by_user_id: 85, /* ... */ });
```

The agent emits a routine heartbeat the whole time:

```typescript
const hb: HeartbeatFeedback = {
  tier: "required",
  type: "heartbeat",
  agentId: "pg-query-optimizer-prod",
  domain: "infrastructure",
  status: "running",
  timestamp: Date.now(),
};
```

### Detection

At hour 52, a query pattern drifts from baseline. The agent emits an `InsightFeedback` signal:

```typescript
const insight: InsightFeedback = {
  tier: "expected",
  type: "insight",
  agentId: "pg-query-optimizer-prod",
  domain: "infrastructure",
  confidence: 0.87,
  summary: "Query `SELECT orders WHERE user_id = ?` is 40% of database CPU, baseline was 6%. Drift started ~6 hours ago. Missing index on orders.user_id.",
  timestamp: Date.now(),
};
```

### Work item creation (detector estimates cost-of-not-building only)

The insight becomes a work item. The Postgres agent is the detector: it observes infrastructure and can estimate the cost of NOT fixing the problem (projected query-cost curve from its own baselines). It has **no business** estimating cost-to-build — that's migration-window + engineering time + review risk, which lives in the engineering domain.

The agent creates the work item in `proposed` status with `costToBuild` unestimated:

```typescript
const proposed: WorkItem = {
  id: "wi_pg_index_orders_user_id_20260421",
  type: "story",
  title: "Add index on orders.user_id",
  description: "Detected hot query consuming 40% DB CPU. Missing index on orders.user_id.",

  domains: ["infrastructure", "engineering"],  // cross-domain: infra detects, engineering estimates
  source: "agent",
  sourceAgentId: "pg-query-optimizer-prod",
  lineage: undefined,

  costToBuild: {
    amountUsd: 0,
    basis: "unestimated — engineering to provide during researching phase",
    // no providedBy — cost-to-build is the engineering domain's to fill in
  },

  costOfNotBuilding: {
    amountUsd: 340,
    breakdown: { debtAccumulation: 340 },
    basis: "Projected monthly query cost if the traffic curve continues. Current run-rate: $260/mo and climbing.",
    providedBy: "infrastructure",
    estimatorAgentId: "pg-query-optimizer-prod",
    estimatedAt: Date.now(),
  },

  confidence: 0.87,
  status: "proposed",

  createdAt: Date.now(),
  updatedAt: Date.now(),
};
```

### Enhancement (engineering domain fills in cost-to-build)

Routing rules ([`patterns/FEEDBACK-PROCESSING-SPEC.md`](patterns/FEEDBACK-PROCESSING-SPEC.md) §3.1) deliver the `proposed` work item to the engineering domain. An engineering agent (or engineer) estimates cost-to-build based on similar past migrations, then updates the work item and transitions its status:

Note the estimate attribution on the proposed work item: `costOfNotBuilding` carries `providedBy: "infrastructure"` and names the specific agent that made the call. `costToBuild` has no attribution yet — engineering hasn't weighed in. This is the detector/estimator handoff ([`patterns/WORK-ITEM-SPEC.md`](patterns/WORK-ITEM-SPEC.md) §6) made visible in the data itself.

```typescript
// Engineering-domain update — fills in costToBuild with attribution
await workItems.update(proposed.id, {
  costToBuild: {
    amountUsd: 50,
    breakdown: { tokens: 5, compute: 45 },
    basis: "Similar migrations at Loom: 30-60 min agent time + ~20 min migration window on the replica.",
    providedBy: "engineering",
    estimatorAgentId: "migration-cost-estimator-prod",
    estimatedAt: Date.now(),
  },
  status: "researching",   // engineering is on it
});

// After estimate lands and peer review signs off:
await workItems.update(proposed.id, { status: "ready" });
```

Only `ready` means "both costs present, priority engine can score it." Work items in `proposed` status are excluded from priority queries until the cross-domain estimate handoff completes. This is the general Meridian pattern: detectors describe the world; executors estimate their part; priority and scheduling come after the data is complete. A work item may pick up further enhancement (risk notes, CompetingContext, revised estimates with updated `estimatedAt`) throughout its life.

### Graduated enforcement

Before the migration runs, the work item passes through three tiers ([`patterns/FEEDBACK-PROCESSING-SPEC.md`](patterns/FEEDBACK-PROCESSING-SPEC.md) §3.5):

- **mechanical** — index syntax valid; no duplicate with an existing one on `orders.user_id`; migration plan passes schema-check.
- **agent_review** — a reviewer agent checks for write-path regressions (an index has a write-cost; the covering column selectivity is validated against the actual write volume on `orders`).
- **human_gate** — the infrastructure steward approves the prod migration. The approval is recorded as a `QualitySignal` with `result: "pass"` and `enforcementTier: "human_gate"`.

### Observability

Every step is attributed to the work item. The runtime's Observability primitive ([`core/RUNTIME-SPEC.md`](core/RUNTIME-SPEC.md) §4.6) carries `workItemId` as an automatic dimension, so cost, traces, and logs are correlated end-to-end. The steward sees the full chain from detection through approval in one view.

---

## Chapter 2: The Amplitude Agent (cross-domain handoff)

The second chapter shows a feature the first doesn't: `CompetingContext`. The Amplitude agent proposes an experiment; the UX agent disagrees. Both sides are machine-readable. The product steward resolves.

### Spawn

```typescript
const config: SpawnConfig = {
  id: "amplitude-funnel-watcher-prod",
  domain: "product",
  limits: { maxCostUsd: 30, maxTokensTotal: 60000, maxTokensPerCall: 4000 },
  metadata: { surface: "onboarding-v1" },
};
```

### Detection

The Amplitude agent watches the onboarding funnel. It notices step 3 drop rate spiked from 18% to 30% starting three days ago.

```typescript
const insight: InsightFeedback = {
  tier: "expected",
  type: "insight",
  agentId: "amplitude-funnel-watcher-prod",
  domain: "product",
  confidence: 0.91,
  summary: "Onboarding step 3 drop rate 30% (baseline 18%). 4800 users affected in 72 hours. Drift coincides with release r-2026-04-18.",
  timestamp: Date.now(),
};
```

### Proposed work item (detector creates; cost-to-build unestimated)

Same pattern as Chapter 1: the Amplitude agent observes product metrics. It can estimate cost-of-not-building (projected lost activation revenue from the drop). It cannot estimate what it costs engineering and design to run an A/B copy experiment — that's eng-domain information.

```typescript
const experiment: WorkItem = {
  id: "wi_onboarding_v2_experiment_20260421",
  type: "story",
  title: "Run onboarding copy v2 A/B experiment",
  description: "Hypothesis: step 3 drop is caused by unclear copy. Propose A/B test with rewritten copy.",

  domains: ["product", "engineering"],
  source: "agent",
  sourceAgentId: "amplitude-funnel-watcher-prod",
  lineage: "wi_onboarding_drop_root_cause_20260421",

  costToBuild: {
    amountUsd: 0,
    basis: "unestimated — product engineering to provide",
  },

  costOfNotBuilding: {
    amountUsd: 8400,
    breakdown: { revenueImpact: 8400 },
    basis: "Projected lost activation revenue if drop persists for 30 days.",
    providedBy: "product",
    estimatorAgentId: "amplitude-funnel-watcher-prod",
    estimatedAt: Date.now(),
  },

  confidence: 0.72,
  status: "proposed",

  createdAt: Date.now(),
  updatedAt: Date.now(),
};
```

### Competing context from the UX agent (arrives before cost-to-build enhancement)

The UX agent agrees there's a drop, but has counter-evidence. It raises a `CompetingContext` ([`patterns/FEEDBACK-PROCESSING-SPEC.md`](patterns/FEEDBACK-PROCESSING-SPEC.md) §2.3):

```typescript
const objection: CompetingContext = {
  sourceAgentId: "ux-regression-watcher-prod",
  contestedWorkItemId: "wi_onboarding_v2_experiment_20260421",
  concern: "sla_risk",
  impact: {
    affectedConsumers: 4800,
    revenueAtRiskUsd: 12000,
    blastRadius: "module",
    breakingDependencies: ["mobile-web-onboarding-v1.4"],
  },
  argument:
    "Step-3 drop correlates 1:1 with mobile viewport regression in r-2026-04-18; the rendering is broken on Safari iOS below 390px. Running a copy A/B will dilute the signal and the copy will appear to win or lose for the wrong reason.",
  suggestedAlternative:
    "Fix the viewport regression first, re-measure for 72 hours, then decide whether the experiment still adds value.",
  confidence: 0.84,
};
```

### Human gate

The product steward sees both sides in one view: the Amplitude agent's `proposed` experiment and the UX agent's competing context. Note what this catches: the objection arrives **before engineering has estimated cost-to-build** — the work item never had to leave `proposed` status for the steward to see that the underlying hypothesis is likely wrong. That's cycles saved on estimation work that would have been wasted.

Blast radius is `module`, which is below the escalation threshold spec'd in [`patterns/PRIORITY-ENGINE-SPEC.md`](patterns/PRIORITY-ENGINE-SPEC.md) §4. At `module`-scope, the decision is steward-judgment; the steward approves the UX agent's alternative.

The result is written back to the system as a work-item lineage. The Amplitude agent's experiment is superseded with a link to the UX finding; the viewport fix becomes a new `proposed` work item with the UX agent as source (engineering will estimate cost-to-build as before). Both sides are preserved in the audit record.

---

## Chapter 3: When to reach for patterns

### Core vs patterns — what adopters actually implement

Meridian splits into two layers with different conformance commitments:

- **Core** ([`core/`](core/)) — data shapes on the wire and in primitives. Transport, runtime primitives, feedback envelope, skill declaration. Any implementation claiming Meridian conformance implements the stable primitives defined here.
- **Operating patterns** ([`patterns/`](patterns/)) — opinionated ways to organize work and process feedback. Domain stewardship, two-cost work items, graduated enforcement, optional-tier feedback signals. Not required for core conformance. Strongly recommended for the distinctive Meridian value.

### When core alone is enough

A simple agent mesh that exchanges messages, emits heartbeats and cost signals, and respects resource limits can be fully Meridian-conformant without any of the pattern content. You get the transport, the runtime contract, and the observability shape. No stewards, no two-cost work items, no graduated enforcement.

This is the HTTP-without-REST case: correct, standards-conformant, and useful for specific kinds of adopters.

### When patterns become load-bearing

The patterns start to earn their complexity when:

- The human team is small enough that you need agents to carry ops load, and you need a way to delegate gated decisions back to humans without opening tickets (graduated enforcement).
- Real dollar budgets matter more than story points (work item schema with two cost estimates).
- Multiple agents legitimately disagree and the system needs to surface evidence rather than pick a winner (competing context).
- Compound learning over time is a goal, not an afterthought (quality signals plus the meta-loop).

For Loom Loyalty specifically, the patterns aren't optional. Loom is designed to run with a small human team stewarding domain agents, with real-time cost attribution as a first-class property. The patterns are the mechanism that delivers that.

### Explicit non-goals

Meridian does not try to be:

- An orchestrator (LangGraph, CrewAI, Autogen, Temporal already cover this)
- A prompt framework
- An evaluation suite
- A vector store or retrieval layer
- A UI

It is a protocol. It specifies shapes. Adopters pick orchestrators and frameworks that suit their needs.

### Forward-pointers

- **Priority engine** — `patterns/PRIORITY-ENGINE-SPEC.md` lands in v1.0-draft.5. Data shapes and escalation are normative; the WSJF-derived formula ships as a reference implementation in `@loom-loyalty/meridian-priority-reference`.
- **Conformance test suite** — planned for `@loom-loyalty/meridian-conformance`. Gate on v1.0 finalization.
- **Runtime adapters** — the reference Cloudflare adapter (`@loom-loyalty/meridian-runtime-cloudflare`) ships alongside v1.0. Other adapters welcome via the community process.

---

*Draft document. The opening scene and chapter narrative voice need a final pass from Nate; field values are verified against the shipping types in `@loom-loyalty/meridian-types`. Feedback welcome via issues and pull requests.*