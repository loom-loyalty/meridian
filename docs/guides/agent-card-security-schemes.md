# AgentCard `securitySchemes`

Every Meridian worker serves an A2A-shaped `AgentCard` at
`/.well-known/agent-card.json`. The `securitySchemes` field tells
clients and peer agents how to authenticate before calling gated
routes.

## The shape

```json
{
  "protocolVersion": "v1",
  "name": "my-meridian-app",
  "description": "Meridian runtime scaffolded by `meridian init`",
  "version": "0.1.0",
  "transports": {
    "http": { "url": "https://my-meridian.workers.dev" }
  },
  "agents": [{ "id": "hello", "domain": "demo" }],
  "securitySchemes": {
    "bearer": {
      "type": "http",
      "scheme": "bearer",
      "description": "Shared-secret bearer token. Send `Authorization: Bearer <MERIDIAN_ADMIN_TOKEN>` on all mutation routes."
    }
  }
}
```

The `securitySchemes` object follows the [OpenAPI 3.1 SecurityScheme](https://spec.openapis.org/oas/v3.1.0#security-scheme-object)
shape, same as A2A AgentCard. Clients that already speak A2A parse
it without special handling.

## Empty = open

When `createMeridianWorker` is called without `auth: { bearer }`,
`securitySchemes` is an **explicitly empty object**:

```json
{
  "securitySchemes": {}
}
```

This is deliberate. An empty object is a signal to adopters (and
`meridian doctor`) that the worker is reachable without auth. If you
expected auth to be on and see `{}` here, your config didn't wire
through — check that `env.MERIDIAN_ADMIN_TOKEN` is set at deploy
time.

## Turning it on

```ts
// src/worker.ts
export default createMeridianWorker({
  agents: [...],
  auth: { bearer: env.MERIDIAN_ADMIN_TOKEN },
});
```

After `wrangler deploy`:

```bash
curl https://my-meridian.workers.dev/.well-known/agent-card.json | jq .securitySchemes
```

Should print:

```json
{
  "bearer": {
    "type": "http",
    "scheme": "bearer",
    "description": "..."
  }
}
```

If you still see `{}`, the bearer value evaluated to empty string or
undefined. Check the secret:

```bash
wrangler secret list                   # confirm MERIDIAN_ADMIN_TOKEN is bound
```

## Which routes are gated

When `auth.bearer` is set:

| Route                               |                        Gated                        |
| ----------------------------------- | :-------------------------------------------------: |
| `GET /`                             |                     no (health)                     |
| `GET /.well-known/agent-card.json`  |                   no (discovery)                    |
| `GET /agents/:id`                   |                      no (read)                      |
| `GET /agents/:id/inbox`             |                      no (read)                      |
| `POST /agents/:id/spawn`            |                         yes                         |
| `DELETE /agents/:id`                |                         yes                         |
| `POST /agents/:id/messages`         |                         yes                         |
| `POST /agents/:id/broadcast`        |                         yes                         |
| `POST /agents/:id/inbox/drain`      |                         yes                         |
| `GET /admin/*`                      | yes (reads included — admin is operational surface) |
| Custom routes (via `config.routes`) |    no — adopter calls `enforceBearer` explicitly    |

## Custom routes

Custom routes are NOT auto-gated. This is deliberate — some adopter
routes (a public `/health` probe, a `/conformance` endpoint) need to
stay open. If your custom route SHOULD be authenticated, call
`enforceBearer` at the top:

```ts
import { enforceBearer } from "@loom-loyalty/meridian-runtime-cloudflare";

createMeridianWorker({
  agents: [...],
  auth: { bearer: env.MERIDIAN_ADMIN_TOKEN },
  routes: {
    "POST /internal/trigger": (req, env) => {
      enforceBearer(req, { bearer: env.MERIDIAN_ADMIN_TOKEN });
      // ... handler body
    },
  },
});
```

## Future schemes

v0.1 ships bearer only. v0.1.5 adds OIDC and OAuth2 via the
`AuthPlugin` interface (not exported publicly until the second
implementation stabilizes the interface). When those land, this
guide grows a section per scheme.

## Rotation

```bash
# 1. Mint a new token
meridian gen-token --dev-vars

# 2. Deploy the new secret
wrangler secret put MERIDIAN_ADMIN_TOKEN  # paste the new value

# 3. Verify round-trip
meridian doctor

# 4. Update any clients that were using the old token
```

There's no overlap window in v0.1 — `config.auth.bearer` is a single
value. Cut over quickly.

## Relationship to tenancy

Bearer auth authenticates the CALLER. Tenancy tells the runtime
which tenant the caller acts on behalf of. Both layer independently:

- Auth off + tenancy off → open single-tenant worker (dev only)
- Auth on + tenancy off → single-tenant worker with shared admin token
- Auth on + tenancy on → multi-tenant worker; adopter's
  `TenantAuthorizer.resolveTenantId(req)` typically reads a `tid` JWT claim
  AFTER `enforceBearer` validates the token itself

See [Tenancy invariants](tenancy-invariants.md) for how multi-tenant
auth typically wires together.
