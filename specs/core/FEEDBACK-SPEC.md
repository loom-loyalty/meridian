# Meridian Feedback Contract Specification

**Version:** 1.0.0-draft.2
**Status:** Draft
**Date:** April 2026
**License:** CC BY 4.0

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document is the feedback contract: the envelope, tier classification, and required + expected signal types every Meridian-compatible component emits. Optional-tier signal types (quality signals, stakeholder impact, competing context, pattern recognition) and the processing mechanisms that consume them are defined in [`../patterns/FEEDBACK-PROCESSING-SPEC.md`](../patterns/FEEDBACK-PROCESSING-SPEC.md).

---

## 1. Purpose

This specification defines the feedback contract for Meridian-compatible systems. Every component (agent, infrastructure, tool, service) that participates in a Meridian system must emit structured feedback signals. This contract defines what those signals look like, which are required, and how they're classified.

The feedback contract is the foundation of Meridian's self-improving loop: components report state, that state creates work, work changes the system, and the system reports again.

---

## 2. Feedback tiers

Meridian classifies feedback into three tiers based on what the system requires to function.

### Required (system breaks without this)

Every component must emit these. If a component cannot produce required feedback, it cannot participate in a Meridian system.

**Heartbeat and state.** Is this component alive? What state is it in?

Valid states: `running`, `degraded`, `overloaded`, `initializing`, `draining`, `offline`.

Heartbeat interval is configurable but defaults to 30 seconds. A component that misses three consecutive heartbeats is considered unhealthy. The reconciliation loop uses this to drive corrective actions.

**Cost attribution.** Real-time, continuous cost reporting broken into categories: compute, tokens (input and output separately), tool calls, storage, network. Attributed to specific work items when possible.

Cost signals must be continuous, not batch. The system must be able to answer "what does this agent cost right now?" at any moment. Acceptable latency between cost incurrence and cost signal emission: under 1 second for per-agent queries.

**Errors and failures.** Structured error reporting. Every error carries:

- Severity: `critical`, `high`, `medium`, `low`
- Category: free-form string (e.g., `infrastructure`, `logic`, `dependency`, `timeout`, `resource`)
- Frequency: `first`, `recurring`, `escalating`
- Blast radius: `user`, `customer`, `all_customers`, `internal`
- Recovery status: `recovered` (boolean)

Errors drive the self-heal vs. create-ticket decision tree. Critical errors with `recovered: false` trigger immediate escalation.

**Dependencies.** What this component depends on. What depends on this component. The business context attached to those relationships.

Dependency declarations are the foundation for impact analysis. When a change is proposed that affects a component, its dependency declaration tells the system who else will be affected and what the consequences are.

### Expected (system degrades without this)

Components should produce these. The system works without them but is less intelligent.

**Metrics with baselines.** Not just current values but deviation from established norms. Components maintain their own baselines and report deviations. A metric signal that says "latency is 340ms" is less useful than one that says "latency is 340ms, baseline is 85ms, drift started 6 hours ago."

**Insights with confidence.** The interpreted meaning of metrics. "These 3 queries are consuming 40% of database CPU." "Users drop off at step 3 of onboarding 68% of the time." Every insight carries a confidence score between 0.0 and 1.0. High confidence can trigger automated action. Low confidence gets flagged for human review.

**Capacity and headroom.** Not just "how am I doing now" but "how much more can I handle before I degrade." Expressed as current/max with a unit. Capacity signals drive scaling decisions and inform cost forecasting.

**Forecasts.** Forward projections based on trends. "At current growth rate, this database hits storage limits in 14 days." "Based on token usage trends, this agent pool will exceed monthly budget by the 22nd." Forecasts create work items with lead time instead of creating fires.

### Optional (makes the system smarter over time)

Not required, but the more components produce these, the more intelligent the system becomes. The specific signal types (quality signals, user/stakeholder impact, competing context, pattern recognition) and the processing mechanisms that consume them are defined in [`../patterns/FEEDBACK-PROCESSING-SPEC.md`](../patterns/FEEDBACK-PROCESSING-SPEC.md).

---

## 3. Signal format

All feedback signals share a common envelope:

```typescript
interface FeedbackEnvelope {
  tier: "required" | "expected" | "optional";
  type: string; // discriminator for signal type
  agentId: AgentId; // who emitted this
  domain: DomainId; // which domain context
  timestamp: Timestamp; // when this was emitted
  workItemId?: WorkItemId; // correlation to specific work, if applicable
}
```

Individual signal types extend this envelope with type-specific fields. See `@loom-loyalty/meridian-types` for the complete TypeScript definitions.

---

## 4. Emission requirements

- Required signals must be emitted even during degraded operation. An agent that is `overloaded` still emits heartbeats and cost signals.
- All signal emission must be non-blocking. Feedback emission must not slow down the component's primary work.
- Signals are fire-and-forget from the emitter's perspective. The emitter does not wait for acknowledgment.
- The transport layer (defined in the Runtime Spec) handles delivery guarantees.

---

## 5. Security: signal authenticity

Signals that carry a `sourceAgentId` or similar identity claim must be validated by the runtime. In particular, runtimes MUST validate that `CompetingContext.sourceAgentId` (defined in [`../patterns/FEEDBACK-PROCESSING-SPEC.md`](../patterns/FEEDBACK-PROCESSING-SPEC.md)) matches the authenticated agent emitting the signal. Contexts that fail this check MUST be rejected with `PERMISSION_DENIED`. This is defense-in-depth: downstream consumers such as the priority engine (see [`../patterns/PRIORITY-ENGINE-SPEC.md`](../patterns/PRIORITY-ENGINE-SPEC.md)) cannot make the check alone, since by the time an invalid context reaches them the rejection surface has moved out of the trust boundary.

---

## 6. Versioning

This specification follows semantic versioning. The feedback signal types are versioned alongside the `@loom-loyalty/meridian-types` package. New signal types can be added in minor versions. Existing signal type shapes are frozen within a major version.

---

_Draft document. Comments welcome via pull request._
