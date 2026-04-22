# `MRD-CF-AU-*` — Auth errors

Bearer-auth failures on gated routes. Introduced in M4a. See
[AgentCard `securitySchemes` guide](../guides/agent-card-security-schemes.md).

## `MRD-CF-AU-001` — missing Authorization header

**Category:** `unauthenticated` (HTTP 401) · **Retryable:** no

A route gated by `config.auth.bearer` was called without an
`Authorization` header. Mutation routes on `/agents/*` and all
`/admin/*` routes are gated when `auth` is configured.

**Fix**

```bash
curl -H "Authorization: Bearer $MERIDIAN_ADMIN_TOKEN" \
  https://your-worker.workers.dev/admin/domains
```

## `MRD-CF-AU-002` — token mismatch

**Category:** `unauthenticated` (HTTP 401) · **Retryable:** no

`Authorization: Bearer <token>` was present but the token doesn't
match `config.auth.bearer`. Comparison is constant-time so timing
attacks don't leak prefix match progress.

**Fix**

- Rotate: run `meridian gen-token --dev-vars` locally, then
  `wrangler secret put MERIDIAN_ADMIN_TOKEN` with the new value
- Ensure the deployed token matches the one you're sending.
  `meridian doctor` checks this round-trip.

## `MRD-CF-AU-003` — unsupported auth scheme

**Category:** `unauthenticated` (HTTP 401) · **Retryable:** no

`Authorization` header uses a scheme other than `Bearer`. v0.1
accepts only `Bearer <token>` (case-insensitive on the scheme,
case-sensitive on the token).

**Fix**

Rewrite the header:

```
Authorization: Bearer <token>
```

OIDC / OAuth2 / custom `AuthPlugin` schemes land in v0.1.5.
