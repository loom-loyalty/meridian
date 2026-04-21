# @loom-loyalty/meridian-types

## 0.3.0

### Minor Changes

- 0784199: Resolve two spec drifts flagged during runtime-cloudflare v0.1 planning.

  **`InsightFeedback.summary`** — narrative examples in
  `MERIDIAN-IN-PRACTICE.md` Ch 1 use a single `summary` field, but the type
  only defined `message` + `category`. Add `summary?: string` as the
  preferred narrative form. `message` and `category` become optional to
  keep backward compatibility with earlier draft implementations;
  producers SHOULD supply at least one of the three forms.

  **`DomainBudget.lastUpdatedAt`** — the priority engine explainer already
  threads a `readAt` timestamp through its budget staleness annotation,
  and DOMAIN-SPEC §3 requires `currentSpendUsd` freshness to be
  observable. Expose that freshness on the domain budget directly via an
  optional `lastUpdatedAt: Timestamp` field. Non-breaking, additive;
  explainers can now read the value off the domain object instead of
  needing a separate parameter.

  Both changes are additive at the type-shape level. Existing in-repo
  consumers continue to typecheck. External consumers on TypeScript
  strict mode that destructure `insight.message` or `insight.category`
  into variables typed as `string` will see `string | undefined` after
  this bump and need to add a null check. No known external consumers
  exist at this pre-1.0 stage; tagging as minor rather than major on
  that basis. If we learn of downstream consumers during v0.1.x, we
  will re-evaluate.

## 0.2.0

### Minor Changes

- b6d540f: Initial publication of the priority engine data contracts and reference
  implementation alongside spec `v1.0.0-draft.5`.
  - `@loom-loyalty/meridian-types` gains the priority-engine surface:
    `WeightProfile`, `DomainPriorityConfig`, `CircuitBreakerConfig`,
    `AgentPriorityQuery`, `AgentPriorityResponse`, `PrioritizedWorkItem`,
    `PriorityLearner`, `PriorityAnnotation`, `WeightDelta`, `Duration`.
    `Domain` gains optional `priorityConfig`. `CostEstimate` gains optional
    `providedBy` / `estimatorAgentId` / `estimatedAt` for the
    detector/estimator handoff. `ErrorCategory` converted from a TypeScript
    `enum` to a string literal union; `MessageType` converted from a
    TypeScript `enum` to a `const` object + derived numeric union
    (both changes are API-compatible for callers using literal values).
  - `@loom-loyalty/meridian-wire` adds `PRIORITY_QUERY` (0x40) and
    `PRIORITY_RESPONSE` (0x41) message types.
  - `@loom-loyalty/meridian-priority-reference` is published for the
    first time. Reference WSJF-derived engine with circuit-breaker,
    explainer, three default weight profiles, `NoOpLearner`.
