---
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M3b: `examples/cf-hyperdrive-postgres` — first native-Cloudflare
example agent + two parity fixes in the runtime it surfaced.

**Example** (new `examples/cf-hyperdrive-postgres/`)

A `PostgresQueryOptimizer` agent that polls `pg_stat_statements`
every 15 min via Hyperdrive. Queries that stay slow for ≥1 hour
emit an `InsightFeedback` (with `summary` narrative, evidence,
suggested action, confidence derived from sustained ticks) and
create a `proposed` `WorkItem` with `costOfNotBuilding` filled in
from measured query cost (the detector side of the detector /
estimator handoff; `costToBuild` stays zero pending a downstream
estimator).

Ships with:

- `src/agent.ts` — hooks, confidence math, insight + work-item
  shaping
- `src/worker.ts` — `createMeridianWorker` with two custom routes
  (`POST /bootstrap`, `GET /insights`)
- `wrangler.toml` — Hyperdrive binding + DO bindings + Observability
  enabled
- `migrations/0001-create-observations.sql` — `pg_stat_statements`
  setup + optional observation-log table
- `test/agent.test.ts` — 4 tests using `createTestRuntime()` that
  verify spawn seeding, cron registration, idempotent re-spawn,
  LC-001 domain-conflict rejection, and list-by-prefix state access
- `README.md` + `DEPLOY.md` — 15-min deploy walkthrough

Tests run in-memory in <300 ms — no Miniflare, no Postgres, no
Hyperdrive.

**Runtime additive: `AgentContext.env`**

Adopter agents need access to their own env bindings (Hyperdrive,
KV, R2, Secrets) from inside hooks. `AgentContext` now exposes
`env: AgentEnv` — adopters cast to their extended env type to
access typed bindings:

    interface PgMonitorEnv extends AgentEnv { HYPERDRIVE: Hyperdrive }
    async onSchedule(ctx) {
      const env = ctx.env as PgMonitorEnv;
      const conn = env.HYPERDRIVE.connectionString;
    }

Purely additive — existing specs without `env` access work
unchanged. Wired in `contextFor` in both the CF adapter and the
in-memory runtime.

**Runtime additive: `/agent` subpath + hook invocation in
`createTestRuntime`**

The main package entry transitively imports `cloudflare:workers`
via the DO classes, which breaks node-based tests. New
`@loom-loyalty/meridian-runtime-cloudflare/agent` subpath exports
only `defineAgent` + the relevant types (all type-only re-exports,
no Workers dependency). Adopter agent modules import from
`/agent`, their worker.ts imports the DO classes from the main
entry.

`createTestRuntime()` now invokes adopter hooks (`onSpawn`,
`onMessage`, `onTerminate`) with a proper `AgentContext` — closes
a parity gap with the CF adapter. `onSchedule` still skipped
(requires alarm semantics the in-memory runtime doesn't implement;
real-CF covers it). The in-memory hook path:

- `onSpawn` fires after the agent state is seeded
- `onMessage` fires per message, per recipient, after inbox write
  (matches CF adapter's at-least-once semantics — hook throw
  doesn't lose the message)
- `onTerminate` fires before state is wiped

Hook throws are caught + swallowed (in-memory has no obs backend).
Matches the CF adapter's non-fatal-hook-error contract.

**Test totals**

- `runtime-cloudflare`: 99/99 still green
- `examples/cf-hyperdrive-postgres`: 4/4 green (all new)

**Next**

M3c: `examples/docker-kafka` — interop-pattern external agent
connecting via the `createMeridianWorker` HTTP surface.
