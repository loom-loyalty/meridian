---
"@loom-loyalty/meridian-conformance": minor
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M2e: runtime conformance suite + in-memory test runtime + E2E
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
Errors (1): categorized MRD-CF-* pattern-match.

**In-memory test runtime** (`@loom-loyalty/meridian-runtime-cloudflare/testing`)

- `createTestRuntime()` returns a `Runtime` whose state lives in
  process-local `Map`s. Adopter unit tests exercise agent hooks with
  millisecond setup — no Miniflare, no `wrangler dev`, no DO.
- Implements every primitive the scenarios exercise:
  lifecycle, state (with 1024 B key / 1 MB value caps + reserved `__`
  prefix), scheduling (1s/365d bounds, `croner` cron parsing),
  transport (sender-partitioned inbox with 1024-message cap +
  MRD-CF-TR-003), resources (all MRD-CF-RS-* enforcement),
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
