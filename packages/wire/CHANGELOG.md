# @loom-loyalty/meridian-wire

## 0.2.5

### Patch Changes

- a3d91a5: No-op patch to exercise the fixed OIDC publish path.

  The Release workflow's publish job now uses Node 24 (which ships
  npm 11.x natively) instead of attempting to upgrade Node 22's
  bundled npm 10.x in place. The in-place upgrade path hit a
  `Cannot find module 'promise-retry'` race on the GH runner
  that --force didn't resolve.

  After this lands, every `@loom-loyalty/meridian-*` package gets
  published with signed provenance via the full Trusted Publishers
  OIDC pipeline.

- Updated dependencies [a3d91a5]
  - @loom-loyalty/meridian-types@0.4.3

## 0.2.4

### Patch Changes

- 85c31fc: Verify Trusted Publishers OIDC flow across every package.

  No-op patch bump that forces every `@loom-loyalty/meridian-*`
  package to republish via the OIDC + Trusted Publishers pipeline.

  Why a deliberate no-op bump: the first real publish run
  (changesets published via `gh workflow run release.yml` from
  PR #38) 404'd on `meridian-conformance` and
  `meridian-runtime-cloudflare`. npm returns 404 (not 403) when a
  Trusted Publisher config is missing or mismatched for a specific
  package — confusingly, "package not found" covers both "doesn't
  exist" and "exists but no TP entry matches". That first run
  confirmed OIDC tokens mint correctly and provenance attestations
  land in Sigstore (indices 1360301067, 1360301068) — just the
  per-package TP entries were incomplete.

  TP is now configured on all six. This changeset exercises each
  one so we verify the full pipeline in one run:
  - 6 separate npm publishes, each with its own OIDC token
  - 6 separate provenance attestations in Sigstore
  - 6 registry entries bumped by a patch version

  If any single package 404s on this run, that's the one with a
  TP config problem — isolated signal instead of hoping subsequent
  changesets happen to touch it.

  Adopter-facing change: none. No code changes in this commit; the
  behavior is identical across all 6 packages.

- Updated dependencies [85c31fc]
  - @loom-loyalty/meridian-types@0.4.2

## 0.2.2

### Patch Changes

- Updated dependencies [81a0e39]
- Updated dependencies [ab88293]
  - @loom-loyalty/meridian-types@0.4.0

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
