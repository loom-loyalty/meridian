# @loom-loyalty/meridian-conformance

## 0.3.3

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

## 0.3.2

### Patch Changes

- bf85abc: Retry scenarios that fail with CF's cold-DO error-mask.

  Real-CF sometimes wraps DO-thrown `RuntimeError`s as
  `"internal error; reference=<hex>"` on the RPC boundary when the
  Durable Object is cold. The expected `MRD-CF-*` error is visible in
  the DO-side `logRpcError` trace, but callers see the generic mask.
  Subsequent calls on the now-warm DO return the true error.

  The runner's `isTransientDOError` now matches
  `/internal error;\s*reference\s*=\s*[a-z0-9]+/i` in addition to the
  existing "Durable Object reset" pattern. Retry budget unchanged at
  1 — deterministic failures still fail.

  Adopter-facing change: none. If your conformance runs were flaking
  on real-CF with CF internal-error references, they will now pass on
  the automatic retry. If a scenario fails across both attempts, that
  is a real bug; the result + reason surface unchanged.

## 0.3.0

### Minor Changes

- 0c8d075: M5: E2E CI hardening + verified-on-CF badge.

  **New conformance scenario**

  `concurrency-spawn-broadcast-fanout` — spawns N=12 agents in the same
  domain in parallel, has each broadcast once, then asserts every
  recipient's inbox ends with exactly N-1 messages (excludes sender).

  Exercises RegistryDO + mailbox DO concurrency under load that no
  existing scenario touches — every previous scenario uses a small
  fixed set of agents. Applies to all three runtime kinds
  (`in-memory`, `miniflare`, `real-cf`) so divergence between them
  shows up as a red build on the parity test.

  The N=12 fan-out runs ~48 DO RPCs per scenario. Picked to be
  meaningful without overrunning the ~30s real-CF Worker CPU budget
  under the batched `/conformance` pager.

  **Verified-on-CF badge**

  Root `README.md` now carries `E2E (Cloudflare)` and `CI` badges. The
  E2E badge tracks
  `.github/workflows/e2e-cloudflare.yml` on `main` — green means the
  full runtime conformance suite (including the new M5 fan-out
  scenario) ran against a real Cloudflare Workers deployment on the
  latest push, not a Miniflare emulator.

  **Packages table refresh**

  Every package previously listed under "Roadmap" has shipped. Table
  now reflects what's on npm + links the `meridian-cli` scaffolder.
  Only `@loom-loyalty/meridian-proxy` remains on the roadmap for v1.0.

  **DEPLOY-CI.md refresh**

  Documents what the E2E workflow covers today — deploy, smoke probe,
  batched conformance runner, `wrangler tail` capture on failure,
  conditional teardown. Removes the "what grows in M2" section (all
  of that has since landed).

  **Test totals**
  - `runtime-cloudflare`: 123 → 123 tests green (conformance scenario
    count goes 31 → 32, but the outer test file already runs the full
    `runtimeScenarios` export — no new `it()` block needed).
  - `conformance` suite now publishes 32 scenarios total (31 prior +
    1 new concurrency scenario).

### Patch Changes

- Updated dependencies [81a0e39]
- Updated dependencies [ab88293]
  - @loom-loyalty/meridian-types@0.4.0

## 0.2.0

### Minor Changes

- fdfeea7: M2f Phase 1: conformance coverage expansion + 2 real-CF adapter bug
  fixes the new scenarios surfaced.

  **New conformance scenarios (6 added; suite now runs 31 scenarios)**
  - `state-list-prefix` — `list({prefix})` returns only prefix-matching
    keys, alphabetically sorted.
  - `state-list-pagination` — `list({limit, cursor})` pages through keys
    with no duplicates. Surfaces a bug in the CF adapter (see below).
  - `transport-inbox-cap` — per-(sender, recipient) inbox caps at 1024
    messages; 1025th throws `MRD-CF-TR-003`. Miniflare + in-memory only
    (1024 serial sends exceed the Worker fetch CPU envelope under
    `/conformance`).
  - `transport-broadcast-cross-domain` — explicit `selector.domain`
    targets that domain's agents, not the sender's.
  - `transport-broadcast-late-spawn` — agents spawned AFTER a broadcast
    do not receive the prior message (RUNTIME-SPEC §4.4).
  - `errors-codes-reachable` — every MRD-CF-\* code in the stable catalog
    is reachable from the public RPC surface. Catches drift where a code
    is defined but no public path throws it.

  **Runtime-cloudflare bug fixes** (both surfaced by the new scenarios)
  - **`cf-state.ts:list()` cursor was inclusive.** DO storage.list
    treats `start` as inclusive, so passing a raw cursor duplicated the
    cursor key as the first entry of the next page — `state-list-
pagination` returned `["item-01","item-02","item-03","item-03",
"item-04","item-05","item-05",...]`. Fixed by appending
    `String.fromCharCode(0)` to the cursor to get the strict-greater
    successor. No valid adopter key sorts between `${cursor}` and
    `${cursor}\0`, so pagination is now duplicate-free.
  - **`agent-do.ts` state methods didn't gate on `requireMeta()`.**
    Pre-spawn `save` / `load` / `delete` / `list` /
    `incrementAtomic` / `receiveAll` / `drainInbox` resolved against
    the CF adapter but threw `MRD-CF-LC-002` against `createTestRuntime()`
    — a real parity bug the `errors-codes-reachable` scenario caught.
    Fix: every state- and inbox-read method now `await
lifecycle.requireMeta()` before delegating. One `MRD-CF-LC-002`
    error code covers "agent not present" across every adopter-facing
    RPC (pre-spawn or post-terminate). - `walking-skeleton.test.ts` post-terminate `load` assertion updated
    to expect the `MRD-CF-LC-002` reject (the DO is "dead" until a
    new spawn rebinds it; returning `undefined` silently was
    inconsistent with every other RPC).

  **Runner diagnostic expansion**

  `runner.ts` failure-reason formatter now captures:
  - `err.constructor.name` (e.g. `RuntimeError` vs `TypeError` vs
    `AssertionError` — distinguishes MRD-CF throws from unexpected
    JS errors)
  - `err.code` when present (bracketed after the constructor)
  - Up to 3 levels of `err.cause` chain (`new Error(msg, {cause})`
    propagation)
  - First 6 stack frames

  Prior format lost the cause chain and didn't reveal whether the
  error type matched expectations. Next real-CF failure produces
  meaningfully more signal.

  **Test totals**
  - `runtime-cloudflare/test/`: 87 tests green (unchanged count;
    conformance suite now runs 31 scenarios internally, up from 25)
  - `conformance/src/runtime/scenarios/`: 31 scenarios published

  **What this does NOT cover (deferred)**
  - `transport-at-least-once` (onMessage hook-throw retry) — requires
    `defineAgent` from scenario code; not in the Runtime contract yet.
    Covered by `runtime-cloudflare/test/hooks.test.ts` A3 suite.
  - `transport-hibernation-replay` — real-CF only, needs external
    orchestration (write → sleep through eviction window → read).
    Workflow-level, M2f Phase 2.
  - `scheduling-coalesce` / `scheduling-durability` — same shape as
    hibernation-replay. Workflow-level.
  - `resources-setlimits-inflight` — needs `beginOperation` on the
    public RPC surface; it's currently hook-only. API expansion
    decision for v0.2 or adopter-facing testing API.
  - `observability-dimensions` — needs Analytics Engine capturing or
    console.error spy (not reachable through the Runtime contract).
    Covered by `runtime-cloudflare/test/observability.test.ts`.

- edc9c23: M2e: runtime conformance suite + in-memory test runtime + E2E
  conformance step.

  **New subpath** `@loom-loyalty/meridian-conformance/runtime`
  - `Runtime` contract — the abstraction scenarios run against. Adopter
    runtimes (CF, in-memory, future platforms) implement `.agent(id)`,
    `.runAlarm(id)`, `.sleep(ms)`, and advertise `.kind:
"in-memory" | "miniflare" | "real-cf"`.
  - `AgentRef` — per-agent RPC surface the scenarios call into. Mirrors
    `AgentDurableObject`'s public methods, scoped to a bound id. New
    methods added here as the suite grows.
  - `runRuntimeConformance(runtime, scenarios, opts?)` — walks the
    scenario list, gates each by `appliesTo` against the runtime kind,
    collects `{scenario, status, reason, durationMs}` results.
    Scenarios that don't apply are `skipped`, not silently dropped —
    adopters see the coverage they're missing under their adapter.
  - `summarizeConformance(results)` — reduce to `{ok, passed, failed,
skipped, total}`.
  - `expect(actual, desc)` / `expectReject(promise, pattern, desc)` —
    tiny synchronous assertion primitives so adopters can run the suite
    from a plain node script without pulling vitest.

  **Scenarios (25 total)**

  Lifecycle (3): basic, idempotent, requires-spawn.
  State (5): isolation, reserved-keys, size-limits, concurrent-update,
  durability (real-cf only).
  Scheduling (4): bounds, cron-bounds, cancel, fires (miniflare+in-memory
  only — workerd alarm scheduler is outside the Worker invocation
  budget).
  Transport (4): ordering, payload-limit, broadcast, drain.
  Resources (7): limits-round-trip, enforcement, negative-reports,
  attribution, usage-shape, warnings, latency.
  Experimental (1): unavailable.
  Errors (1): categorized MRD-CF-\* pattern-match.

  **In-memory test runtime** (`@loom-loyalty/meridian-runtime-cloudflare/testing`)
  - `createTestRuntime()` returns a `Runtime` whose state lives in
    process-local `Map`s. Adopter unit tests exercise agent hooks with
    millisecond setup — no Miniflare, no `wrangler dev`, no DO.
  - Implements every primitive the scenarios exercise:
    lifecycle, state (with 1024 B key / 1 MB value caps + reserved `__`
    prefix), scheduling (1s/365d bounds, `croner` cron parsing),
    transport (sender-partitioned inbox with 1024-message cap +
    MRD-CF-TR-003), resources (all MRD-CF-RS-\* enforcement),
    experimental (UNAVAILABLE throws).
  - Exposes `inspect(id)` + `seed(fixture)` escape hatches for
    debugging a failed scenario or pre-loading fixtures.

  **Parity test** (`runtime-cloudflare/test/conformance.test.ts`)

  Three suites:
  1. Miniflare adapter runs every Miniflare-applicable scenario.
  2. In-memory runtime runs every in-memory-applicable scenario.
  3. Parity: Miniflare and in-memory MUST report the same
     `{scenario, status}` pair set. Divergence = red build.

  **E2E conformance step** (`.github/workflows/e2e-cloudflare.yml`)

  The workflow now curls `/conformance` on the live-deployed worker
  after the smoke check. The endpoint runs the suite on-box with
  `kind: "real-cf"` and returns `{summary, results}` JSON. Workflow
  asserts `summary.failed === 0` and `summary.passed > 0`.

  Real-CF-applicable scenarios (23 of 25) cover every adopter-facing
  primitive the runtime ships in v0.1. `scheduling-fires` and
  `state-durability` skip:
  - `scheduling-fires` — workerd fires alarms outside the Worker
    invocation budget; M3 example agents cover the live-alarm path.
  - `state-durability` — workerd does not expose hibernation triggers
    to user code; M3 longer-running integration driver covers
    cross-hibernation durability.

  **Test totals**
  - `runtime-cloudflare/test/`: 84 → 87 tests (added 3 conformance
    describe blocks).
  - `conformance/src/runtime/scenarios/`: 25 scenarios published.

  **Public API additions**

  From `@loom-loyalty/meridian-conformance/runtime`:
  - `Runtime`, `AgentRef`, `ConformanceScenario`, `ConformanceResult`,
    `ScenarioContext`, `RunConformanceOptions`, `AgentFixture` types
  - `runRuntimeConformance`, `summarizeConformance` functions
  - `expect`, `expectReject` assertion primitives
  - `runtimeScenarios` const — the v0.1 scenario list
  - Per-primitive named scenario exports (`lifecycleBasic`,
    `stateIsolation`, etc.) so adopters can run a subset.

  From `@loom-loyalty/meridian-runtime-cloudflare/testing`:
  - `createTestRuntime()` — returns `TestRuntime extends Runtime`
  - `TestRuntime.inspect(id)` / `TestRuntime.seed(fixture)`

  **Closes M2.** Next milestone is M3 (example agents:
  `cf-hyperdrive-postgres` + `docker-kafka`).

## 0.1.1

### Patch Changes

- Updated dependencies [0784199]
  - @loom-loyalty/meridian-types@0.3.0
