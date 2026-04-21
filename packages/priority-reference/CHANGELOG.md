# @loom-loyalty/meridian-priority-reference

## 0.2.1

### Patch Changes

- Updated dependencies [0784199]
  - @loom-loyalty/meridian-types@0.3.0

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

### Patch Changes

- Updated dependencies [b6d540f]
  - @loom-loyalty/meridian-types@0.2.0
