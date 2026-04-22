# Roadmap

Known deferred work from the v0.1 milestones (M1-M7). Grouped by
target release. Each item links to the PR or changeset where it was
deferred.

Open an issue if you need any of these sooner than the scheduled
release — priority shifts when adopters speak up.

## v0.1.5 — planned

Small additive layer on top of v0.1. Targets the adopter gaps from
the M6 + M4 Reviewer Concerns that didn't block GA.

### Auth

- [ ] **`AuthPlugin` interface** — OIDC / OAuth2 / custom schemes.
      Interface stays internal in v0.1 until a second concrete
      implementation stabilizes the shape. Shared-secret bearer
      (v0.1) keeps working without code changes.
      Origin: [M4a changeset](.changeset/m4a-bearer-auth.md)
- [ ] **WebSocket transport bearer auth** — today's worker has no
      WebSocket endpoint (admin tail / A2A JSON-RPC arrive here).
      Origin: [M4a changeset](.changeset/m4a-bearer-auth.md)
- [ ] **A2A JSON-RPC transport** — pin version, enumerate methods,
      lifecycle mapping, SSE events. Companion to AuthPlugin so
      adopters can front the runtime with a standards-shaped API.
      Origin: [M4a changeset](.changeset/m4a-bearer-auth.md)

### Admin + CLI

- [ ] **`GET /admin/domains/:id/queue`** — domain work-item queue
      endpoint. Needed before `meridian queue <domainId>` can
      graduate from placeholder.
      Origin: [M4c changeset](.changeset/m4c-meridian-cli.md)
- [ ] **`GET /admin/agents/:id/tail` (WebSocket)** — streaming logs
      / events. Unblocks `meridian tail <agentId>`.
      Origin: [M4c changeset](.changeset/m4c-meridian-cli.md)
- [ ] **`meridian tail <agentId>`** — CLI client for the WebSocket
      tail. Currently accepted by the CLI but errors until the
      backing endpoint ships.
      Origin: [M4c changeset](.changeset/m4c-meridian-cli.md)
- [ ] **`meridian queue <domainId>`** — CLI client for the domain
      queue endpoint.
      Origin: [M4c changeset](.changeset/m4c-meridian-cli.md)
- [ ] **Anonymous CLI telemetry** — opt-in signal on
      `init` / `demo` / `doctor` so we can measure adopter TTHW
      in the wild without tracking individuals. Default off; needs
      a consent flow on first use.
      Origin: [DX review decision in the M1-M7 plan](~/.gstack/projects/loom-loyalty-meridian/ceo-plans/2026-04-21-runtime-cloudflare.md)

### Tenancy

- [ ] **`TenantLimits.maxCostUsd`** — tenant-wide aggregate cost
      cap. Per-agent `ResourceLimits.maxCostUsd` already enforced
      in v0.1; aggregation across agents in a tenant is the missing
      piece.
      Origin: [M6 changeset](.changeset/m6-tenancy.md)
- [ ] **Analytics Engine `meridian.tenant_id` auto-tagging** — every
      `obs.metric` call gets the current tenant stamped
      automatically. Adopters can pass it manually today via the
      `tags` arg.
      Origin: [M6 changeset](.changeset/m6-tenancy.md)

### Types package

- [ ] **Promote `TenantLimits` to `@loom-loyalty/meridian-types`** —
      currently internal to the CF adapter. Only promote once a
      second runtime implementation wants the shape.
      Origin: [M1-M7 plan spec-drift notes](~/.gstack/projects/loom-loyalty-meridian/ceo-plans/2026-04-21-runtime-cloudflare.md)

## v0.2 — planned

Larger surface expansions.

### Primitives

- [ ] **`snapshotState` + `SpawnConfig.fromSnapshot`** — graduate
      from experimental (`MRD-CF-EX-001` / `MRD-CF-EX-002`) to
      stable. R2-backed state export.
      Origin: [errors catalog](docs/errors/experimental.md)
- [ ] **`PermissionScope` enforcement** — graduates `MRD-CF-EX-003`
      from "dropped with warning" to real enforcement when
      AuthPlugin lands. Coupled with `setPermissions` /
      `getPermissions` leaving UNAVAILABLE state.
      Origin: [errors catalog](docs/errors/experimental.md)

### Admin

- [ ] **Reference dashboard** — hosted or embeddable UI for
      `/admin/*` routes. Deferred to v0.2 to keep v0.1 CLI-only.
      Origin: [M1-M7 plan](~/.gstack/projects/loom-loyalty-meridian/ceo-plans/2026-04-21-runtime-cloudflare.md)

### Tenancy

- [ ] **Per-tenant CF account-quota caps** — caps at the
      RegistryDO level on concurrent spawns / CPU / subrequests per
      tenant. Shuttle-sized deploys need this to prevent one tenant
      starving others.
      Origin: [Reviewer Concern #3 in the M1-M7 plan](~/.gstack/projects/loom-loyalty-meridian/ceo-plans/2026-04-21-runtime-cloudflare.md)

### Observability

- [ ] **OTEL exporter composition** — `startSpan()` currently
      returns a no-op span in v0.1 (buffers + drops attributes).
      Wire to a real OTEL exporter when the tracing story
      solidifies.
      Origin: `packages/runtime-cloudflare/src/observability/cf-analytics.ts`

### Sharded registry

- [ ] **16-shard RegistryDO fan-out** — eng-review decision from the
      M1-M7 plan. `/admin/domains` today queries a single shard per
      tenant. Moving to 16 shards per tenant and fanning out
      in parallel keeps us under Workers subrequest limits under
      high-agent-count load.
      Origin: [M4b changeset](.changeset/m4b-admin-routes.md)

### Docs

- [ ] **`meridianprotocol.dev` hosting** — docs are written in
      `docs/`; the runtime `MeridianError.docUrl` field already
      points at `https://meridianprotocol.dev/errors/...`. Missing
      piece is the static site publisher.
      Origin: [M7 changeset](.changeset/m7-docs-closer.md)
- [ ] **Hosted playground** at `meridianprotocol.dev/playground` —
      champion-tier TTHW (< 2 min). Requires ongoing CF hosting
      ops; weighed against effort for v0.2.
      Origin: [DX review in the M1-M7 plan](~/.gstack/projects/loom-loyalty-meridian/ceo-plans/2026-04-21-runtime-cloudflare.md)

## Post-v0.2 / under evaluation

Ideas with a clear home but no committed release.

- [ ] **Hibernation-replay conformance scenario** — currently covered
      by transport-at-least-once + transport-hibernation parity
      across in-memory / Miniflare / real-CF. A dedicated scenario
      would need a way to force DO hibernation deterministically
      in CI; Cloudflare doesn't expose that today.
      Origin: [M5 hardening discussion](.changeset/m5-e2e-hardening.md)
- [ ] **Real-CF alarm-drift scenario** — existing
      `scheduling-fires` skips on real-CF because the alarm
      scheduler runs outside the Worker invocation budget. M3 cron
      examples (`cf-hyperdrive-postgres`, `docker-kafka`) cover the
      live-alarm path end-to-end but don't assert drift.
      Origin: plan's M5 bullet ("real-CF alarm drift")
- [ ] **Load tests beyond concurrency-fan-out** — M5 added an N=12
      fan-out scenario. A N=100+ load test would need to run
      outside the Worker CPU budget (separate harness, not the
      `/conformance` pager).
      Origin: plan's M5 bullet ("load tests")

## Not on our roadmap — operator concerns

These belong to multi-tenant operators (Shuttle and similar) and
intentionally stay OUT of the reference runtime. Meridian provides
the hooks; the operator builds the control plane.

- Tenant provisioning flow (who creates a tenant, how billing
  activates)
- Cross-region routing
- Spawn-bomb rate limiting per tenant (except the per-tenant
  concurrency caps above, which ARE planned)
- Tenant-level backup / export
- Multi-tenant audit aggregation
- Hyperdrive per-tenant credentials — requires adopter-side
  plumbing or a credential broker (see the forthcoming
  `integration-proxy` package)

See [Tenancy invariants](docs/guides/tenancy-invariants.md) for the
full boundary.

## Recently shipped

For the full history, see the [CHANGELOG](packages/runtime-cloudflare/CHANGELOG.md)
on each package. v0.1 milestones:

| Milestone | Scope                                                             | Status          |
| --------- | ----------------------------------------------------------------- | --------------- |
| M1        | Walking skeleton on Miniflare                                     | shipped         |
| M2        | Six stable primitives + conformance                               | shipped         |
| M3        | Example agents (cf-hyperdrive-postgres, docker-kafka)             | shipped         |
| M4a       | Shared-secret bearer auth + AgentCard securitySchemes             | shipped (#27)   |
| M4b       | `/admin/domains` + `/admin/agents/:id`                            | shipped (#29)   |
| M4c       | `meridian` CLI (init / gen-token / demo / doctor + admin clients) | shipped (#30)   |
| M5        | E2E CI hardening + concurrency fan-out + verified-on-CF badge     | shipped (#31)   |
| M6        | Opt-in multi-tenancy                                              | shipped (#32)   |
| M7        | Adopter docs + error catalog + Deploy-to-CF button                | in flight (#33) |
