---
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M2d: resources primitive + observability plugin + `onSchedule` hook +
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
