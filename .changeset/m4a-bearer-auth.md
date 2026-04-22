---
"@loom-loyalty/meridian-types": minor
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M4a: Shared-secret bearer auth for `createMeridianWorker`.

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
  + admin clients (`inspect/tail/queue/domains`) with token handling.
