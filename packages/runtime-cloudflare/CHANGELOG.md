# @loom-loyalty/meridian-runtime-cloudflare

## 0.6.3

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
  - @loom-loyalty/meridian-conformance@0.3.3

## 0.6.2

### Patch Changes

- Updated dependencies [bf85abc]
  - @loom-loyalty/meridian-conformance@0.3.2

## 0.6.0

### Minor Changes

- 81a0e39: M4a: Shared-secret bearer auth for `createMeridianWorker`.

  Before this, the worker was fully open — anyone who guessed the URL
  could spawn agents, send messages, terminate. The M3 examples
  warned adopters to keep the URL private; now the runtime can
  enforce auth itself.

  **Adopter API**

  ```ts
  createMeridianWorker({
    agents: [...],
    auth: { bearer: env.MERIDIAN_ADMIN_TOKEN },
  });
  ```

  When `auth.bearer` is set, every mutation route on the built-in
  surface (`POST /agents/:id/spawn`, `DELETE /agents/:id`,
  `POST /agents/:id/messages`, `POST /agents/:id/broadcast`,
  `POST /agents/:id/inbox/drain`) requires
  `Authorization: Bearer <token>` or rejects with a `MRD-CF-AU-*`
  code. Reads (`GET /`, `GET /.well-known/agent-card.json`,
  `GET /agents/:id`, `GET /agents/:id/inbox`) stay open — discovery
  and polling don't need a secret.

  When `auth.bearer` is absent or empty, the worker stays open (same
  behavior as before M4a). Adopters running publicly MUST configure
  auth or restrict via Cloudflare Access / private URL.

  Custom routes (passed via `config.routes`) are NOT auto-gated —
  adopters call `enforceBearer(req, config.auth)` explicitly at the
  top of any handler that needs it. Keeps public custom endpoints
  (`/conformance`, `/healthz`) working without reconfiguration.

  **AgentCard `securitySchemes`**

  `GET /.well-known/agent-card.json` now populates `securitySchemes`
  when auth is enabled:

  ```json
  {
    "securitySchemes": {
      "bearer": {
        "type": "http",
        "scheme": "bearer",
        "description": "Shared-secret bearer token. ..."
      }
    }
  }
  ```

  A2A-aware clients can discover the required scheme without a
  separate probe. An empty `securitySchemes: {}` object is now an
  explicit signal that the worker is open — adopters who forgot to
  configure auth see this on their smoke check.

  **New error codes (MRD-CF-AU-\*)**

  All three map to HTTP 401 with `category: "unauthenticated"`.
  - `MRD-CF-AU-001` — no Authorization header on a gated route
  - `MRD-CF-AU-002` — Bearer token doesn't match the configured secret
  - `MRD-CF-AU-003` — Authorization header uses a non-Bearer scheme

  Token comparison is constant-time (XOR accumulation over UTF-8 bytes)
  so timing attacks against the secret don't work by default.

  **New exports**

  From `@loom-loyalty/meridian-runtime-cloudflare`:
  - `enforceBearer(req, config.auth)` — call from custom route handlers
    to gate them the same way built-ins are gated
  - `AuthConfig`, `BearerAuthConfig` types

  **Types-package update**

  `ErrorCategory` gains `"unauthenticated"` (minor bump).
  Pre-existing `permission_denied` stays for authorization failures
  (AuthZ, not AuthN); the new category covers `no-valid-credential`
  paths. Matches gRPC status-code conventions.

  **Test totals**
  - `runtime-cloudflare`: 105 → 114 tests green (+9 auth tests covering
    missing header, wrong scheme, wrong token, correct token accepted,
    constant-time byte-level rejection, empty-bearer = disabled,
    AgentCard securitySchemes in both modes, read routes stay open).

  **v0.1 scope gates**
  - Only shared-secret bearer. OIDC / OAuth2 / custom `AuthPlugin`
    interface lands in v0.1.5 when a real second implementation
    stabilizes the interface (eng-review decision 2026-04-21).
  - No WebSocket transport auth yet. Current worker has no WebSocket
    endpoint (/admin/tail WebSocket lands in M4b alongside admin
    routes).

  **Next**
  - M4b: admin routes (`/admin/agents/:id/inspect`, `/admin/domains`,
    `/admin/domains/:id/queue`) — all bearer-gated via the same
    helper.
  - M4c: `packages/meridian-cli` — `meridian init/gen-token/demo/doctor`
    - admin clients (`inspect/tail/queue/domains`) with token handling.

- 41fef1d: M4b: Admin routes for `createMeridianWorker`.

  Adds two read-only operational endpoints adopters (and the upcoming
  `meridian` CLI) can call to introspect a live runtime without
  cracking open the Durable Object internals themselves.

  **New routes**

  ```
  GET /admin/domains           → list registered agents grouped by domain
  GET /admin/agents/:id        → unified inspect: handle + schedules +
                                  usage + state keys + inbox length
  ```

  Every admin route is gated by bearer auth when `config.auth.bearer`
  is set. Unlike the `/agents/*` surface, admin reads are gated too —
  enumerating the registry / draining state keys is operationally
  sensitive enough that leaving it open without a token would surprise
  adopters.

  **Response shapes**

  ```jsonc
  // GET /admin/domains
  {
    "domains": [
      { "domain": "adm-x", "agentIds": ["a", "b"] },
      { "domain": "adm-y", "agentIds": ["c"] },
    ],
  }
  ```

  Domains and `agentIds` are sorted alphabetically so the response is
  deterministic.

  ```jsonc
  // GET /admin/agents/:id
  {
    "agent": {
      "id": "...",
      "domain": "...",
      "status": "running",
      "spawnedAt": 1234567890,
    },
    "schedules": [
      /* ScheduleInfo[] */
    ],
    "usage": {
      "limits": {
        /* ResourceLimits */
      },
      "current": {
        "memoryMB": 0,
        "cpuMsLifetime": 0,
        "tokensLifetime": 0,
        "costUsdLifetime": 0,
        "activeOperations": 0,
      },
      "warnings": [],
    },
    "state": {
      "keys": [
        /* string[] */
      ],
      "cursor": "...", // optional, for pagination
    },
    "inbox": { "length": 3 },
  }
  ```

  Pre-spawn inspect returns HTTP 404 with `MRD-CF-LC-002`.

  **Error mapping**
  - Unknown `/admin/*` path → 404
  - Non-GET on a known admin path → 405 with `Allow: GET`
  - Auth configured but missing header → 401 `MRD-CF-AU-001`
  - Wrong bearer token → 401 `MRD-CF-AU-002`

  **Test totals**
  - `runtime-cloudflare`: 114 → 123 tests green (+9 admin tests covering
    domain grouping + sort contract, inspect payload shape, pre-spawn
    404, unknown admin path, 405 on non-GET, bearer required + wrong
    token paths).

  **v0.1 scope gates**
  - Read-only. No spawn / terminate / send on the admin surface —
    those stay on `/agents/*` where adopters already drive them.
  - Single-registry-shard lookup for `/admin/domains`. When the sharded
    registry lands in M6, the fan-out across all 16 shards is additive
    (same response shape, more internal subrequests).
  - `/admin/domains/:id/queue` and `/admin/tail` (WebSocket) stay on
    the roadmap for M4c / post-M4; the shape above is minimal-viable
    for the CLI's `inspect` and `domains` commands.

  **Next**
  - M4c: `packages/meridian-cli` — `meridian init/gen-token/demo/doctor`
    plus admin clients (`inspect/tail/queue/domains`) that hit these
    routes with the configured `MERIDIAN_ADMIN_TOKEN`.

- ab88293: M6: Opt-in multi-tenancy for `createMeridianWorker`.

  Adopters can now run one Meridian runtime across multiple tenants
  without forking. Tenancy is **off by default** — existing deploys
  upgrading from M5 see no change to their DO addresses, registry
  keys, or `AgentHandle` shape. Multi-tenant adopters (Shuttle and
  similar) opt in by providing a `TenantAuthorizer`.

  **Adopter API**

  ```ts
  import {
    createMeridianWorker,
    type TenantAuthorizer,
  } from "@loom-loyalty/meridian-runtime-cloudflare";

  class JwtTenantAuthorizer implements TenantAuthorizer {
    async resolveTenantId(req: Request): Promise<string> {
      const { tid } = await verifyJwt(req);
      return tid;
    }
  }

  export default createMeridianWorker({
    agents: [...],
    tenancy: { authorizer: new JwtTenantAuthorizer() },
  });
  ```

  **Server-enforced isolation invariants (tenancy on)**
  1. **DO namespacing** — `env.AGENT.idFromName("${tenantId}::${agentId}")`.
     Same agentId under two tenants maps to two distinct DOs with
     their own SQLite, alarms, inbox.
  2. **Registry scoping** — each tenant gets its own RegistryDO shard
     keyed `${tenantId}::default`. `registry.list()` has zero
     cross-tenant leakage by construction.
  3. **Cross-agent send containment** — when agent A sends to "B",
     the target DO is resolved under A's own tenantId (stored in meta
     at spawn). Sending into another tenant's namespace is impossible.
  4. **Broadcast containment** — broadcasts query only the sender's
     tenant-scoped registry shard.
  5. **Admin route scoping** — `GET /admin/domains` and
     `GET /admin/agents/:id` call the authorizer before reading. A
     tenant-B caller asking about tenant-A's agent gets 404
     `MRD-CF-LC-002`.
  6. **Spawn body cannot spoof tenant** — the worker forces the
     authorizer-resolved `tenantId` onto the spawn config.
  7. **Handle carries `tenantId`** — `AgentHandle` responses from a
     tenant-aware worker include `tenantId`; single-tenant handles
     omit it.

  **Types-package update**
  - `SpawnConfig.tenantId?: string` — optional, additive
  - `AgentHandle.tenantId?: string` — optional, additive (absent on
    single-tenant runtimes, present on multi-tenant)

  **New exports from `@loom-loyalty/meridian-runtime-cloudflare`**
  - `TenantAuthorizer` interface
  - `SingleTenantAuthorizer` — default (returns `"default"`)
  - `TenancyConfig`, `TenantContext` types
  - `scopedAgentName(agentId, tenant)` — exposed for adopters who
    need to compute DO names outside the built-in routes
  - `scopedRegistryKey(tenant)` — exposed for the same reason

  **Backward compatibility**

  Single-tenant mode is bit-for-bit identical to M5. When `tenancy`
  is undefined:
  - DO names stay `env.AGENT.idFromName(agentId)` — no prefix
  - Registry shard stays `"default"`
  - `AgentMeta` omits `tenantId`
  - `AgentHandle` omits `tenantId`

  No migration needed for existing adopter deploys.

  **Test totals**
  - `runtime-cloudflare`: 123 → 129 tests green (+6 tenancy tests
    covering DO namespace isolation, admin `/domains` per-tenant
    listing, cross-tenant inspect returns 404, `tenantId` on handles,
    single-tenant fallback, `SingleTenantAuthorizer` stub behavior).

  **v0.1 scope gates (deferred to v0.1.5)**
  - `TenantLimits.maxCostUsd` aggregate caps across agents in a
    tenant — per-agent `ResourceLimits` still enforced today
  - Analytics Engine `meridian.tenant_id` dimension tag on metrics
    (plumbed through `obs.metric` tags, but not auto-tagged per
    request yet — adopters can add it manually via the adopter-facing
    `AgentContext.obs.metric` tag arg)
  - Tenant provisioning flow, cross-region routing, spawn-bomb rate
    limiting — Shuttle (multi-tenant operator) territory

### Patch Changes

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

- Updated dependencies [81a0e39]
- Updated dependencies [0c8d075]
- Updated dependencies [ab88293]
  - @loom-loyalty/meridian-types@0.4.0
  - @loom-loyalty/meridian-conformance@0.3.0

## 0.5.0

### Minor Changes

- 85e3f51: M3b: `examples/cf-hyperdrive-postgres` — first native-Cloudflare
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

## 0.4.0

### Minor Changes

- f02e14c: M3a: `createMeridianWorker` HTTP entrypoint — the adopter-facing
  helper that makes a single-file Worker out of an agent list.

  Replaces the M1 walking-skeleton stub (`return 501 Not Implemented`
  for every route) with a real minimal REST surface. This is what
  adopters have been writing themselves in ~20 lines of bespoke fetch
  handler (the pattern visible in the prior `test/test-worker.ts`);
  shipping it as a helper keeps every adopter on the same HTTP
  contract and unblocks M3b/M3c example agents.

  **HTTP surface**

  | Method   | Path                           | Purpose                                                |
  | -------- | ------------------------------ | ------------------------------------------------------ |
  | `GET`    | `/`                            | Health (`{runtime, healthy}`)                          |
  | `GET`    | `/.well-known/agent-card.json` | A2A-shaped discovery                                   |
  | `POST`   | `/agents/:id/spawn`            | `{domain}` → AgentHandle, 201                          |
  | `GET`    | `/agents/:id`                  | AgentHandle                                            |
  | `DELETE` | `/agents/:id`                  | Terminate, 204                                         |
  | `POST`   | `/agents/:id/messages`         | `{to, payload: base64}` → MessageReceipt, 202          |
  | `POST`   | `/agents/:id/broadcast`        | `{selector?, payload: base64}` → BroadcastReceipt, 202 |
  | `GET`    | `/agents/:id/inbox`            | `{messages: IncomingMessage[]}` snapshot               |
  | `POST`   | `/agents/:id/inbox/drain`      | `{messages: IncomingMessage[]}` pull-and-clear         |

  Every route delegates to `env.AGENT` DO RPCs — no work in the Worker
  itself beyond request parsing + response shaping. JSON bodies base64-
  encode `Uint8Array` payloads for wire compatibility.

  **Error shaping**

  MRD-CF-\* throws surface as
  `{error: {code, category, message, retryable, docUrl, context?}}`
  with HTTP status mapped from `ErrorCategory`:
  - `invalid_argument` → 400
  - `unauthenticated` → 401
  - `permission_denied` → 403
  - `not_found` → 404
  - `already_exists` / `aborted` → 409
  - `failed_precondition` → 412
  - `resource_exhausted` → 429
  - `unavailable` → 503
  - `deadline_exceeded` → 504
  - `internal` / unmapped → 500

  The DO RPC boundary reconstructs thrown errors as plain `Error`
  (stripping `RuntimeError` class identity), so the helper also parses
  the `[MRD-CF-XX-NNN]` prefix off the message and re-hydrates the
  category / retryable / docUrl via the new `lookupMeridianCode()`
  helper exported from `errors.ts`. `MERIDIAN_ERROR_CODE_RE` is also
  exported so adopters can do the same pattern-match client-side.

  **Custom routes escape hatch**

  `config.routes: Record<"METHOD /path", Handler>` adds or shadows
  routes. The test harness (`test/test-worker.ts`) now uses this to
  layer the `GET /conformance` scenario-runner on top of the standard
  helper — same helper adopters consume in production, same `/agents/*`
  surface, plus one custom route for the E2E workflow.

  **No auth in v0.1.** Docstrings + README call this out explicitly.
  Adopters MUST restrict via Cloudflare Access / IP allowlist / private
  URL until M4 lands bearer auth.

  **Other changes**
  - `index.ts` — exports `createMeridianWorker`, `MeridianWorkerConfig`,
    `MeridianRouteHandler`, plus `lookupMeridianCode` + `MERIDIAN_ERROR_CODE_RE`
    from errors.
  - `errors.ts` — new `lookupMeridianCode(code)` and `MERIDIAN_ERROR_CODE_RE`.
  - `README.md` — replaces the stale "Usage (preview)" section with the
    actual shipped API + a minimum-viable-worker walkthrough.
  - `test/test-worker.ts` — refactored to use the helper (dogfood).
  - `.github/workflows/e2e-cloudflare.yml` — smoke check now asserts
    `.healthy == true` instead of the old `milestone` field (which the
    helper doesn't include).
  - `test/worker-routes.test.ts` — new, 12 HTTP-surface tests covering
    every built-in route plus custom-route precedence.

  **Test totals**
  - 87 → 99 tests green in `runtime-cloudflare` package.
  - Conformance suite unchanged (already covers the underlying RPCs).

  **Next**

  M3b (`cf-hyperdrive-postgres` native-CF example) and M3c
  (`docker-kafka` interop example) build on this helper.

### Patch Changes

- 8320405: Change error catalog `docUrl` base from `https://meridian.dev/errors/`
  to `https://meridianprotocol.dev/errors/`. The `meridian.dev` domain
  wasn't owned by Loom Loyalty; `meridianprotocol.dev` is the canonical
  domain for the project (registered 2026-04-22). Error-catalog pages
  (M7) will live at `meridianprotocol.dev/errors/<CODE>`.

  Touches:
  - `DOC_BASE_URL` in `errors.ts`
  - Inline `docUrl` template in `create-meridian-worker.ts`'s
    re-hydration path (for errors whose class identity was stripped by
    the DO RPC boundary)
  - `test/errors.test.ts` assertions

  No behavior change beyond the URL string. 99/99 tests still green.

## 0.3.1

### Patch Changes

- e349bff: M2f Phase B: DO RPC error surfacing for real-CF flake diagnosis.

  Real-CF runs of the M2e conformance suite surfaced an intermittent
  failure pattern: ~1 run in 3-4 produces `"internal error; reference=
XXX"` from a random DO RPC (different scenario each time —
  `resources-warnings`, `state-durability`, `transport-broadcast` have
  all taken turns). Cloudflare's DO RPC collapses non-standard throws
  into that opaque string at the caller side and drops the DO-side
  stack frames, so the only visible signal was a useless reference ID.

  **Fix: cross-cutting `logRpcError` wrapper**
  - New `log-rpc-error.ts` — single helper that catches any throw
    inside a DO RPC method body and `console.error`s the constructor
    name, error code, message, cause chain, and full stack BEFORE
    re-throwing.
  - `AgentDurableObject`: every public RPC method + the `alarm()`
    handler now wraps its body in `logRpcError("method", async () =>
{ ... })`. 25 wrapped entry points.
  - `RegistryDurableObject`: same treatment for `register`,
    `unregister`, `lookup`, `list`.

  **What this buys us**

  Workers Logs (via Cloudflare dashboard) and `wrangler tail`
  streaming (the E2E workflow captures this) now see the originating
  stack with its MRD-CF-\* code and plugin / primitive-level frames.
  Next time the real-CF suite flakes, the tail output will show
  exactly which plugin threw what, instead of the CF-wrapped
  reference ID.

  **Trade-off: log noise from expected throws**

  Scenarios that intentionally trigger MRD-CF-\* throws (via
  `expectReject`) now produce a `console.error` line per rejection.
  That's ~15-25 lines per conformance invocation. Adopters who want
  a quieter surface can filter by `code` starts-with `MRD-CF-` and
  route known errors to a lower severity. We chose uniform logging
  over conditional filtering so there's one log format and no "did
  this pass through the wrapper" uncertainty.

  **Test totals**
  - `runtime-cloudflare/test/`: 87/87 tests still green. The wrapping
    is transparent to callers — same return values, same thrown error
    types, just an added log line on throw.

  **Next**

  If real-CF still flakes after this lands, the tail output will name
  the plugin / primitive. At that point the fix is localized (not
  speculative). If the flake disappears on retry but only when
  observable this way, the wrapping itself might be sufficient (the
  act of catching may change JIT / input-gate behavior enough to
  avoid the race).

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
