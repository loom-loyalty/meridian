# `MRD-CF-LC-*` — Lifecycle errors

Errors raised by `AgentDurableObject` on spawn / suspend / resume /
terminate paths. See [RUNTIME-SPEC §4.1](../../specs/core/RUNTIME-SPEC.md#41-agent-lifecycle).

## `MRD-CF-LC-001` — spawn identity conflict

**Category:** `already_exists` (HTTP 409) · **Retryable:** no

The DO was addressed via `idFromName(X)` but already has meta stored
for a different `(id, domain)` or `(tenantId, id, domain)` tuple.
Spawning is idempotent for the same identity; changing identity on
an existing DO is rejected.

**Common causes**

- Adopter re-used an agent id after changing the agent's domain
- Multi-tenant worker accidentally spawned the same id under a new
  tenantId without terminating the old one first
- DO state from a previous deploy persisted past a code rename

**Fix**

- Terminate the existing agent before re-spawning with different
  identity: `DELETE /agents/:id`
- If you need two agents with the same id, pick different ids —
  `idFromName` is 1-to-1 with the bound DO

## `MRD-CF-LC-002` — agent not spawned

**Category:** `not_found` (HTTP 404) · **Retryable:** no

Called a lifecycle / state / transport method on a DO that was never
spawned (or was spawned then terminated). Every method except
`exists()` gates on `requireMeta()` and throws this code when meta
is absent.

**Common causes**

- Client called `/agents/:id/messages` before `/agents/:id/spawn`
- Agent was terminated mid-flight by another caller
- Multi-tenant cross-tenant access: tenant-B calls
  `/admin/agents/tnt-alpha` where `tnt-alpha` only exists under
  tenant-A (by design, this resolves to tenant-B's DO, which has
  no meta)

**Fix**

Spawn first, or confirm the agent is still alive via
`GET /agents/:id`.

## `MRD-CF-LC-003` — resume on terminated agent

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

`resume()` was called after `terminate()`. The terminate path writes
a `__terminated__` sentinel so this path stays distinct from "never
spawned" (which is LC-002).

**Fix**

Spawn a new agent under a different id. Terminated DOs cannot be
revived — their state was deliberately wiped.

## `MRD-CF-LC-004` — spawn missing required fields

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

`SpawnConfig.id` or `SpawnConfig.domain` was absent or empty.

**Fix**

Always pass both: `{ id: "hello", domain: "demo" }`.

## `MRD-CF-LC-005` — spawn identity spoof guard

**Category:** `permission_denied` (HTTP 403) · **Retryable:** no

The DO was addressed via `idFromName(X)` but the spawn body's
`config.id` is not X (or, when tenancy is on, `config.id` and
`config.tenantId` don't combine to produce X's hash). This blocks a
malicious adopter from stamping a forged sender identity on
subsequent `send()` calls.

**Common causes**

- Writing a custom route that addresses a DO with one name and spawns
  it with another
- Multi-tenant: caller tried to spawn `alice` under tenant-B via a
  DO that was bound under tenant-A's namespace

**Fix**

Align the DO binding name with `config.id` (and `config.tenantId`
when tenancy is on). The built-in `/agents/:id/spawn` route handles
this correctly; custom adopter code needs to compute
`idFromName(`${tenantId}::${agentId}`)` via
`scopedAgentName(agentId, tenant)` from
`@loom-loyalty/meridian-runtime-cloudflare`.
