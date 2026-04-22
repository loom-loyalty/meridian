# @loom-loyalty/meridian-runtime-cloudflare

## 0.3.0

### Minor Changes

- 994f647: M2a: extract plugin seams, complete lifecycle + state primitives, ship
  stable MRD-\* error catalog.

  **Plugin seams** (internal, not exported per the eng-review reframing —
  public plugin API waits until v0.2 when a real external plugin lands):
  - `LifecyclePlugin` + `CfLifecyclePlugin` in `src/primitives/`
  - `StatePlugin` + `CfStatePlugin` in `src/primitives/`
  - `AgentDurableObject` composes the plugins; still the single RPC
    boundary Miniflare and real CF both speak.

  **Lifecycle (complete for v0.1):** spawn (returns `AgentHandle` per
  `SpawnConfig`), suspend, resume, terminate, get, exists. `snapshotState`
  and `SpawnConfig.fromSnapshot` throw `MRD-CF-EX-001` / `MRD-CF-EX-002`;
  `SpawnConfig.permissions` drops with a warning (`MRD-CF-EX-003`) per
  the plan's RUNTIME-SPEC §4.1 compliance row.

  **State (complete for v0.1):** save, load, delete, list (with prefix +
  limit + cursor pagination), and an atomic read-modify-write via
  `blockConcurrencyWhile`. Enforces RUNTIME-SPEC §4.2 limits — 1024-byte
  UTF-8 keys, 1 MB JSON-serialized values — plus reserved-prefix
  rejection (`__` for internal metadata, `state::` for the storage
  namespace).

  **Error catalog (stable API):** `MRD-CF-<primitive>-<nnn>` codes, each
  tagged with `ErrorCategory`, retryable flag, and auto-injected
  `docUrl` pointing at `meridian.dev/errors/*`. Helpers:
  `meridianError`, `isMeridianError`, `errorCode`. Codes are part of the
  adapter's stable surface within a major version per the DX review
  decision (2026-04-21).

  **RPC surface note:** the generic `update(key, fn)` method is NOT
  exposed via DO RPC because DO RPC uses structured clone and cannot
  serialize the `updater` function. Inside the DO (adopter code running
  via the defineAgent hooks added in M2c) the plugin method is callable
  normally. For external atomic updates from a Worker fetch handler,
  adopters call specific data-shaped RPCs; `incrementAtomic(key, delta)`
  lands as the pattern and test-coverage hook for M2a.

  **Tests (31 new/updated, all green):**
  - `walking-skeleton.test.ts` — updated to the `SpawnConfig` shape
  - `lifecycle.test.ts` — suspend/resume round-trip, terminated→resume
    rejection, re-spawn after terminate, snapshot UNAVAILABLE,
    fromSnapshot UNAVAILABLE, spawn identity-conflict, missing required
    fields
  - `state.test.ts` — delete, list (prefix, pagination), atomic increment
    with 10-way concurrent serialization, reserved-prefix rejection,
    1024-byte key limit, 1 MB value limit
  - `errors.test.ts` — code→category mapping stability, docUrl presence,
    isMeridianError/errorCode helper semantics

  **vitest-pool-workers config:** switched to `singleWorker: true` +
  `isolatedStorage: false` (was the M1 config) because `isolatedStorage:
true` trips the "Failed to pop isolated storage stack frame" assertion
  until every test uses `using` declarations for DO stubs; tests clean up
  via explicit `terminate()` calls.

  **Not in M2a (scheduled for M2b-M2e):**
  - Scheduling primitive (`cf-scheduling.ts`, croner, DO alarms)
  - Transport mailbox refactor (sender-partitioned per recipient) +
    broadcast + onMessage hook wiring via defineAgent
  - Resources + observability primitives
  - Runtime conformance suite + E2E conformance step
  - Full `defineAgent` progressive-disclosure hooks

- 75a29e2: M2b: scheduling primitive (DO alarms + multi-schedule queue + cron
  coalescing on resume).

  **Ships:**
  - `CfSchedulingPlugin` implementing the `SchedulingPlugin` seam:
    `scheduleAt`, `scheduleCron`, `cancel`, `listSchedules`, `onAlarm`.
  - `AgentDurableObject.alarm()` override hooks the plugin into the DO's
    lifecycle so the scheduled alarm actually fires.
  - `croner` dependency for cron parsing (eng-review decision: DST-aware,
    zero deps, runs in Workers).
  - Stable error codes `MRD-CF-SC-001/002/003/004` for delay bounds, cron
    parse errors, and unknown-id cancels.
  - `drainFiredSchedules()` RPC surface (pull-and-clear log of fires).
    M2c replaces this polling with direct `onSchedule` hook invocation
    on the user's AgentSpec.

  **Design:**
  - Many schedules per agent, ONE DO alarm. Plugin always programs the
    alarm to the earliest `nextFireAt`; when it fires, every due
    schedule is processed in one pass.
  - Once-schedules drop off the list post-fire. Cron schedules advance
    `nextFireAt` to the strictly-future next tick.
  - Coalescing: when the DO has been offline through N cron ticks, the
    plugin fires ONCE with `coalescedTicks = N` rather than firing N
    times. Advances `nextFireAt` past all missed ticks to the next
    future fire. Matches the RUNTIME-SPEC §4.3 "cron coalescing on
    resume" obligation.
  - Delay bounds enforced per spec: ≥ 1 second, ≤ 365 days.

  **Tests (10 new, all green):**
  - scheduleAt < 1s rejected (MRD-CF-SC-001)
  - scheduleAt > 365d rejected (MRD-CF-SC-002)
  - Invalid cron pattern rejected (MRD-CF-SC-003)
  - Unknown cancel id rejected (MRD-CF-SC-004)
  - scheduleAt + listSchedules round-trip
  - cancel removes pending schedule
  - Once-schedule fires via `runDurableObjectAlarm` + 1.2s real-time
    wait; appended to fired log with `coalescedTicks: 1`
  - Multiple due schedules fire in one alarm pass; not-yet-due remains
  - **Cron coalescing**: seed a schedule with `nextFireAt` 10 minutes in
    the past via `runInDurableObject`, trigger alarm, assert
    `coalescedTicks` is 9-12 (every-minute cron) and the schedule's
    new `nextFireAt` is strictly future
  - Scheduling methods all require spawn (MRD-CF-LC-002)

  **Not in M2b (scheduled for M2c):**
  - `onSchedule` hook wiring via `defineAgent` (replaces the polling
    `drainFiredSchedules()` surface)
  - Transport mailbox refactor + broadcast

- 1e3f763: M2c: transport primitive + `defineAgent` hooks.

  **Transport primitive** (`cf-transport.ts`)
  - `TransportPlugin` seam with send / broadcast / deliver / receiveAll
    / drainAll.
  - Mailbox layout per the eng-review decision: **one
    AgentDurableObject per recipient, sender-partitioned storage**.
    Keys are `__mail::${fromAgentId}` + `__mail_seq::${fromAgentId}`.
    Per-sender monotonic sequence numbers (encoded in `messageId` as
    `${fromAgentId}::${seq}`) give the RUNTIME-SPEC §4.4
    "at-least-once + in-order per (sender, recipient) pair" guarantee
    without exploding N² DOs.
  - 1 MB payload validation at both send and receive boundaries →
    `MRD-CF-TR-001`.
  - **Broadcast** via the now-wired RegistryDO: fan-out to agents
    matching `AgentSelector` at call time. Defaults domain filter to
    the sender's own domain when the selector doesn't specify (safe
    default for first-time adopters). `MRD-CF-TR-002` when zero
    recipients match. Late-spawned agents don't receive prior
    broadcasts (spec semantic).
  - Fan-out uses `Promise.allSettled` so one failing delivery doesn't
    fail the broadcast; per-recipient failures logged.

  **`defineAgent` hooks**

  Adopter-facing authoring API — progressive-disclosure hooks that
  run INSIDE the DO with full plugin access (the generic
  `update(key, fn)` path works here because no structured-clone
  boundary is crossed):
  - `onSpawn(ctx)` — fires after spawn persists. Seed baselines,
    register defaults, fire a first heartbeat.
  - `onMessage(ctx, msg)` — fires after each deliver lands. Hook
    errors don't bubble to the sender.
  - `onTerminate(ctx)` — fires before `deleteAll()`. Last chance to
    notify peers or flush external state.

  onSchedule lands in M2d alongside observability.

  `AgentContext` exposes `state` (save/load/delete/list/update),
  `transport` (send/broadcast), and `schedule` (at/cron/cancel). The
  hosting DO constructs the context from its own plugins and passes
  it to every hook invocation.

  **Public API renames** on `AgentDurableObject`:
  - `sendTo(to, payload)` → `send(to, payload)` + returns
    `MessageReceipt` (M1 `sendTo` was void; spec shape now honored)
  - `receive()` → `receiveAll()` (explicit snapshot semantics)
  - Added `drainInbox()` as the pull-and-clear companion
  - Added `broadcast(selector, payload)` returning `BroadcastReceipt`

  These are breaking-within-a-major for the 0.2.x line; no external
  consumers yet.

  **Error catalog additions**
  - `MRD-CF-TR-001` (invalid_argument) — payload > 1 MB
  - `MRD-CF-TR-002` (not_found) — broadcast matched zero recipients

  **Tests (+14 runtime-cloudflare, 55 total in package)**
  - `transport.test.ts` (7): 1 MB rejection, per-sender sequence
    independence, drainInbox vs receiveAll, intra-domain broadcast,
    cross-domain broadcast via explicit selector, empty-selector
    broadcast rejection, late-spawn non-receipt
  - `hooks.test.ts` (5): onSpawn writes state, onMessage records
    deliveries, onTerminate calls transport.send before wipe,
    hooks can call the generic `update(key, fn)`, specless agents
    still work
  - Walking-skeleton updated to the new send/receiveAll API + one
    added "per-sender sequence numbers" assertion
  - +2 existing from M2b (now verifying against the new transport
    plugin) still pass unchanged

  **Not in M2c (scheduled for M2d)**
  - Resources primitive (setLimits, getUsage, onLimitEvent, hard
    limits)
  - Observability primitive (ObservabilityPlugin exported API +
    CF Analytics + Workers Logs)
  - `onSchedule` hook wiring on AgentSpec
  - Inbox unbounded-growth cap (depends on M2d resources)
  - `FiredSchedule.onSchedule` invocation

- 6e636d5: M2d: resources primitive + observability plugin + `onSchedule` hook +
  inbox per-sender cap.

  **Resources** (`cf-resources.ts`, `AgentContext.resources`)
  - `setLimits(ResourceLimits)` / `getLimits()` — persist & read per-agent
    limits (maxTokensTotal, maxTokensPerCall, maxCostUsd, maxConcurrency).
  - `getUsage()` — sub-1-second DO-local read returning counters
    (tokens lifetime, cost USD lifetime, cpuMs lifetime via
    `beginOperation` timing, activeOperations) plus warnings.
  - `reportTokens` / `reportCost` — adopter-reported counters.
    Hard-enforced BEFORE the counter increments so an over-limit call
    fails cleanly without partial accounting:
    - `MRD-CF-RS-001` — reportTokens would exceed maxTokensTotal
    - `MRD-CF-RS-002` — reportCost would exceed maxCostUsd
    - `MRD-CF-RS-003` — reportTokens n > maxTokensPerCall, or negative
  - `beginOperation()` returns an `endOperation` callback; caller
    uses try/finally to decrement the activeOperations counter and
    accumulate CPU time. `MRD-CF-RS-004` on concurrency breach.
  - Warnings emitted at 80% of each limit; `onLimitEvent(handler)`
    registers a fire-and-forget callback. Warnings also surface
    in `getUsage().warnings`.
  - `setPermissions` / `getPermissions` throw `MRD-CF-EX-004/005`
    (still @experimental in v0.1; AuthPlugin in v0.1.5).

  **Observability** (EXPORTED plugin API per eng-review reframing)
  - `ObservabilityPlugin` interface — `log(entry)`, `metric(name,value,tags)`,
    `startSpan(name, parentSpanId)`. Exported from the package as the
    one plugin adopters swap for OTEL / Datadog / Honeycomb.
  - `CloudflareLogsPlugin` — routes `log()` to `console.{debug,info,
warn,error}` (Workers Logs ingests in production). Span-end emits
    a structured log line so adopters can reconstruct trace timing
    without an OTEL exporter.
  - `CloudflareAnalyticsPlugin` — writes Analytics Engine data points
    via `env.ANALYTICS` (optional binding; no-ops when absent).
    Per-point shape: blobs = name + sorted `key=value` tag pairs;
    doubles = [value]; indexes = `[agentId]` when provided (bounded
    cardinality per tenant) — high-cardinality dimensions stay in
    blobs per the M2a review's AE-cardinality follow-up.
  - `CompositeObservabilityPlugin([logs, analytics])` — fan-out
    composition bundled by default. Failing child doesn't take down
    siblings.
  - `AgentContext.obs.log/metric/startSpan` — adopter-facing surface.
    `agentId` + `domain` auto-merged on every emit.

  **onSchedule hook** (`AgentSpec.onSchedule`)
  - Fires once per due schedule in the DO alarm handler, invoked
    after the scheduling plugin's `onAlarm()` persists the fired log.
  - The hook path drains the log, so adopters that use `onSchedule`
    never see entries in `drainFiredSchedules()` (that RPC stays as
    the polling companion for adopters who prefer it).
  - `fire.coalescedTicks` propagates so hooks can see how many ticks
    were folded into a coalesced cron fire.

  **Transport inbox cap** (`MRD-CF-TR-003`)
  - Per-(sender, recipient) partition capped at 1024 messages.
    `deliver()` throws `resource_exhausted` (retryable) when the
    partition is full so the sender sees backpressure instead of a
    silent workerd storage-size failure. Drain the inbox to release
    capacity. Partitioning means a misbehaving sender can't starve
    well-behaved senders' mailboxes.

  **Tests (+21 runtime-cloudflare, 76 total in package, 133 monorepo)**
  - `resources.test.ts` (11): limits round-trip, fresh-usage zeroes,
    token/cost hard caps, per-call cap, negative report rejection,
    warning at 80%, require-spawn, setPermissions/getPermissions
    UNAVAILABLE.
  - `observability.test.ts` (8): Workers Logs per-level routing,
    Analytics Engine data-point shape (blobs + doubles + agentId
    index), composite fan-out, failing-child isolation.
  - `hooks.test.ts` (+1): `onSchedule` fires once per due entry and
    consumes the log.
  - `transport.test.ts` (+1): inbox cap enforcement + drain releases.

  **Public API additions**

  From `@loom-loyalty/meridian-runtime-cloudflare`:
  - `ObservabilityPlugin`, `ObservabilityLogEntry`, `ObservabilitySpan`
    types
  - `CloudflareLogsPlugin`, `CloudflareAnalyticsPlugin`,
    `CompositeObservabilityPlugin` classes
  - `AnalyticsEngineLike` interface
  - `AgentContext.resources` + `AgentContext.obs` on the
    adopter-facing context

  **Not in M2d (scheduled for M2e)**
  - Runtime conformance suite under `packages/conformance/src/runtime/`
  - `createTestRuntime()` helper + parity test between in-memory
    runtime and Miniflare
  - E2E workflow gains a conformance step between smoke and teardown

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

### Patch Changes

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
    RPC (pre-spawn or post-terminate).
    - `walking-skeleton.test.ts` post-terminate `load` assertion updated
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

- 8a108b7: Review-driven fixes from `/review` on cumulative M0-M2b state.

  **Security (critical)**
  - Sender-identity spoofing guard at spawn time. `spawn()` now rejects
    with `MRD-CF-LC-005` if `config.id` doesn't hash to the same DO id
    (`env.AGENT.idFromName(config.id).toString() === ctx.id.toString()`).
    Prior to this check, an adopter could spawn DO `alice` with
    `{id: "bob"}` and `sendTo` would stamp the forged sender as "bob"
    on recipient inboxes. Category: `permission_denied`.
  - E2E workflow label trigger restricted to in-repo PRs only. Fork
    contributors can no longer apply `e2e-cloudflare` to execute
    arbitrary worker code with the CF secrets.

  **Reliability**
  - `CfSchedulingPlugin.onAlarm` coalesce loop bounded at
    `MAX_COALESCE_ITERATIONS = 10_000` to prevent a dense cron
    (e.g. `* * * * *`) offline for long windows from spinning past
    the 30s CPU envelope.
  - `onAlarm` wraps `new Cron(s.cron!)` in try/catch. A single
    corrupted or newly-invalid stored pattern can't crash the entire
    alarm handler and starve every other schedule on the agent.
  - `scheduleCron` enforces the same 365-day horizon as `scheduleAt`.
    Leap-year patterns like `0 0 29 2 *` can legitimately produce a
    `nextRun` up to 4 years out; now rejected with `MRD-CF-SC-002`.
  - `lifecycle.terminate()` explicitly calls `deleteAlarm()` alongside
    `deleteAll()` and accurately documents the ordering (comment was
    backward pre-fix).

  **Data flow consistency**
  - `RegistryDurableObject` is now wired into the lifecycle:
    `spawn()` calls `register(id, domain)` after persisting meta;
    `terminate()` calls `unregister(id)` before wiping. Uses a single
    `"default"` shard key in v0.1; M2c sharding is an additive change.
    Registry failures are logged but don't fail lifecycle ops (the
    registry is a read-side aid, not a source of truth).
  - `CfSchedulingPlugin.listSchedules` no longer peeks into the
    lifecycle plugin's `__meta__` storage directly. Constructor now
    takes an agent-id resolver callback; agent-do wires it to
    `lifecycle.requireMeta().id`.

  **API stability**
  - `AgentDurableObject.incrementAtomic(key, delta)` promoted to
    stable public API. Documented as the canonical non-function RPC
    shape for atomic updates from outside the DO (the generic
    `update(key, fn)` can't cross structured-clone boundaries).
  - `AgentDurableObject.drainFiredSchedules()` promoted to stable
    public API. Batch-poll companion to the `onSchedule` hook landing
    in M2c.

  **Tests**
  - +2 runtime-cloudflare (LC-005 guard + LC-001 domain-change
    branch). Full suite: 100 green across monorepo (23 conformance
    - 34 priority-reference + 43 runtime-cloudflare).

  **Carry-forwards** (flagged by adversarial, scheduled for M2c/M2d):
  - Inbox unbounded growth (agent-do.ts deliver) — M2c mailbox
    refactor.
  - Fired-log unbounded growth (cf-scheduling.ts onAlarm) — M2d
    observability or M2c alongside onSchedule hook.
  - Schedule list 1 MB ceiling — M2c: cap + MRD-CF-SC-005 overflow
    code, or partitioning.
  - JSON.stringify vs structured-clone size-check drift for strings
    with lone surrogates — M2d state-plugin hardening.
  - `list()` cursor deletion-race semantics — M2d state-plugin docs
    - optional `start + "\0"` successor trick.
  - PermissionScope drop emits `console.warn` not a FeedbackSignal —
    M2d observability wiring.
  - Missing error codes: MRD-CF-TR-\*, MRD-CF-RS-\*, MRD-CF-OB-\* —
    fill out as M2c/M2d lands each primitive.

- 6e636d5: Review-driven fixes from `/review` on cumulative M2c+M2d state.
  Adversarial pass (22+ findings). Ten auto-fixes landed as
  auto-corrections during the review and are described under
  "Auto-fixes" below. Three bigger items were reshaped as Accepted
  ASK items and landed here as A1 / A2 / A3.

  **Auto-fixes (during-review corrections)**
  - **Transport: atomic partition record** (`cf-transport.ts`). Mail
    inbox and per-sender sequence counter now live in ONE storage
    value under `__mail::${fromAgentId}` (`MailPartition {inbox,
nextSeq}`). The prior two-key design had a crash window where a
    `put(inbox)` could succeed before `put(seq)` and produce duplicate
    messageIds on retry. Single-key record is atomic by construction —
    no `blockConcurrencyWhile` needed (and `blockConcurrencyWhile`
    throwing shuts down the DO, which made the earlier attempt
    brittle).
  - **Transport: cap check BEFORE seq allocation**. Sending to a full
    partition no longer burns a sequence number.
  - **Transport: numeric tie-break in `sortMailbox`**. Messages with
    equal `receivedAt` now tie-break by numeric sequence, not
    lexicographic messageId (which was wrong — `sender::10 <
sender::2` under string sort).
  - **Transport: `drainAll` preserves `nextSeq` across drains**. The
    inbox array empties but the counter stays so later deliveries
    from the same sender don't reset to 1 and collide with already-
    delivered messageIds on the receipt path.
  - **Resources: `limitHandlers` is now an array, not a single slot**.
    Prior code silently replaced any previously-registered handler
    on each `onLimitEvent(fn)` call. Libraries composing on top of
    the plugin would blow each other's handlers away. Each handler
    is independently try/caught so one bad handler can't take
    siblings down.
  - **Resources: `endOperation` guards against post-terminate
    writes**. Sets a `__terminated__` sentinel on wipe; the
    closure-captured end function checks it before writing the CPU
    counter so an orphan write can't reappear on a freshly respawned
    DO.
  - **Resources: batched `getUsage`**. One `ctx.storage.get([keys])`
    for the full usage snapshot instead of four sequential reads
    (avoids a torn snapshot from concurrent reportTokens/reportCost
    across the DO input gate boundary).
  - **Observability: `CloudflareAnalyticsPlugin` blob budget +
    drop-counter**. Per-point blobs capped at 20 entries × 200 bytes
    (Analytics Engine ~5120 byte total). Overflow triggers a
    `meridian.obs.drops` self-metric so adopters see when
    cardinality exceeds their budget. `writeDataPoint` wrapped in
    try/catch per spec §4.6 (emission MUST NOT throw into the hook
    path).
  - **Observability: `CloudflareLogsPlugin.log()` wraps JSON.stringify
    in try/catch** with a string-fallback path. Circular references
    or unserializable payloads can't crash a hook that logs them.
  - **Resources: `warnings` docstring + bounded emission**. Clarified
    that the `warnings` array caps at one entry per resource type —
    we overwrite rather than append on repeat crossings so the array
    stays bounded regardless of how many report\* calls cross the
    threshold.

  **A1 — Per-workItemId attribution surface** (`MRD-CF-RS`)

  `reportTokens` / `reportCost` accepted a `{workItemId}` attribution
  hint but silently dropped it. RUNTIME-SPEC §4.5 mandates a
  retrievable per-workItemId breakdown, not just an agent-total
  rollup.
  - `cf-resources.ts` now writes per-workItem counters under
    `__usage_wi_tokens::${wid}` / `__usage_wi_cost::${wid}` keys
    alongside the agent-total rollup (double-entry, not either-or).
  - New `getUsageByWorkItem(workItemId?)` on `ResourcesPlugin`,
    `AgentContext.resources`, and `AgentDurableObject` RPC. Returns
    `Array<{workItemId, tokens, costUsd}>` sorted by cost descending.
    Omit the arg for the full breakdown; pass an id for single-entry
    lookup. Unattributed reports do not appear as a phantom row.
  - Sub-1-second per spec §4.5 (direct DO storage reads via
    `ctx.storage.list({prefix})`, not Analytics Engine round-trip).

  **A2 — At-least-once onSchedule via peek + ack** (RUNTIME-SPEC §4.3)

  Prior M2d draft drained the fired-schedule log all-at-once before
  invoking `onSchedule`, meaning a DO crash mid-hook silently lost
  the fire. This violated the at-least-once contract.
  - `CfSchedulingPlugin` adds `peekNextFire()` and `ackFire(fireId)`
    alongside the existing `drainFiredSchedules()` polling companion.
  - `AgentDurableObject.invokeOnScheduleForFires` now uses a
    peek → invoke → ack loop. Ack lands AFTER the hook completes
    (success OR caught throw). If the DO crashes between peek and
    ack, the fire stays in the log and the next alarm replays it.
  - Adopter-code errors inside `onSchedule` still count as delivered
    (we catch and route to the hook-error surface — see A3); only
    actual DO crashes trigger redelivery.
  - `drainFiredSchedules()` stays as the polling API for adopters
    who prefer batch semantics.

  **A3 — Hook-error observability surface**

  Throws in adopter hooks previously ended in a `console.warn` that
  never surfaced through the structured observability pipeline.
  Adopters had no programmatic way to detect "my hook is broken."
  - New `emitHookError(hookName, handle, err, extraFields?)` helper
    on `AgentDurableObject` wired into all five hook catch sites:
    `onSpawn`, `onMessage`, `onSchedule`, `onTerminate`, and the
    `LimitEventHandler` throws routed through
    `CfResourcesPlugin.onHandlerError`.
  - Emits `obs.metric("meridian.hook.errors", 1, {hook, agentId,
domain, errorCode?})` with auto-dimensions merged.
  - Emits `obs.log({level:"error", ...})` with ErrorFeedback-shaped
    fields (`tier:"required"`, `type:"error"`,
    `category:"hook_error:${hookName}"`, `severity:"medium"`,
    `frequency:"first"`, `blastRadius:"internal"`, `recovered:true`).
    Observability backends that forward to a FeedbackSignal channel
    see spec-compliant data.
  - Both emits are try/caught per RUNTIME-SPEC §4.6 (observability
    emission is non-blocking; a broken obs sink cannot cascade into
    the hook's RPC caller).
  - `CfResourcesPlugin` accepts a new optional
    `CfResourcesPluginOptions.onHandlerError` callback at
    construction — the hosting DO wires it; standalone plugin tests
    fall back to the prior `console.warn` path.

  **Test changes (+8 runtime-cloudflare, 84 total in package)**
  - `resources.test.ts` (+2): per-workItemId attribution with mixed
    attributed/unattributed reports; `getUsageByWorkItem()` before
    any attributed report returns `[]`.
  - `scheduling.test.ts` (+2): peek without consume; ack by id
    removes one; crash-simulated replay where the fire survives
    a peek without ack.
  - `hooks.test.ts` (+4): `onSpawn` / `onMessage` / `onSchedule` /
    `onTerminate` throwing hooks — each RPC resolves, DO stays
    usable, `hook_error:${name}` + raw error message both appear in
    the captured `console.error` output (proves the structured
    obs.log path fires).
  - `transport.test.ts`: spec-tightening. The cross-sender
    interleave assertion was over-asserting — RUNTIME-SPEC §4.4
    only guarantees per-pair ordering, and workerd's Date.now()
    can return the same ms for rapid sequential sends, so the
    lexicographic tie-break on `fromAgentId` can cluster by sender.
    Test now asserts the spec invariant (per-pair order + full set
    of messages) not the cross-sender interleaving.

  **Public API additions**

  From `@loom-loyalty/meridian-runtime-cloudflare`:
  - `AgentContext.resources.getUsageByWorkItem()`
  - `AgentDurableObject.getUsageByWorkItem()` RPC
  - `CfResourcesPluginOptions` (internal plugin constructor shape —
    not re-exported; documented for parity)

  No breaking changes. `CfResourcesPlugin` constructor's new second
  argument is optional.

- Updated dependencies [fdfeea7]
- Updated dependencies [edc9c23]
  - @loom-loyalty/meridian-conformance@0.2.0

## 0.2.0

### Minor Changes

- f0a1aa1: Initial 0.1.0 scaffold of `@loom-loyalty/meridian-runtime-cloudflare`:
  the M1 walking-skeleton milestone of the v0.1 runtime adapter plan.

  **Ships in M1:**
  - `AgentDurableObject` (SQLite-backed) with RPC methods for the five
    walking-skeleton primitives: `spawn`, `save`, `load`, `sendTo`,
    `deliver`, `receive`, `terminate`.
  - `RegistryDurableObject` as a single-instance scaffold; the
    16-shard-per-tenant layout from the eng-review decision lands in M2.
  - `defineAgent()` authoring helper (M1: validates + records the spec
    in the module registry; the progressive-disclosure hooks come in M2).
  - `createMeridianWorker()` factory returning a minimal `ExportedHandler`
    (M1: 501s every request; M2 wires up `/.well-known/agent-card.json`,
    `/admin/*`, and WebSocket upgrade).
  - Seven Miniflare integration tests against `@cloudflare/vitest-pool-workers`
    covering the end-to-end skeleton path: spawn idempotence, spawn
    identity-conflict rejection, save/load round-trip, one-hop send, inbox
    arrival order, send-before-spawn rejection, and terminate-wipes-all.

  **Not yet implemented (scheduled for M2+):**

  WebSocket transport, AgentCard endpoint, admin HTTP routes, bearer auth,
  resource enforcement, observability plugin, scheduling (with `croner`),
  full tenancy plumbing, full six-primitive conformance.

  See `~/.claude/plans/enter-plan-mode-to-delegated-dawn.md` for the full
  roadmap; `packages/runtime-cloudflare/README.md` for the adopter preview.

### Patch Changes

- Updated dependencies [0784199]
  - @loom-loyalty/meridian-types@0.3.0
