# @loom-loyalty/meridian-types

## 0.4.2

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

## 0.4.0

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
