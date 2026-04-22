# `MRD-CF-EX-*` — Experimental-method errors

`@experimental` primitives that throw `UNAVAILABLE` in v0.1. They
exist in the type surface so adopter code can reference them and
compile, but every call path rejects until the feature lands.

## `MRD-CF-EX-001` — `snapshotState` unavailable

**Category:** `unavailable` (HTTP 503) · **Retryable:** no

`agent.snapshotState()` throws here. Snapshot / restore lands in
v0.2 with R2-backed state export.

**Workaround (v0.1)**

Export state manually via `agent.list({prefix: ""}).keys` then
`agent.load(k)` per key. Adopter-side, not durable across code
versions, but sufficient for debugging.

## `MRD-CF-EX-002` — `SpawnConfig.fromSnapshot` rejected

**Category:** `unavailable` (HTTP 503) · **Retryable:** no

Spawn with `fromSnapshot: "..."` rejected. Paired with EX-001 —
both land together in v0.2.

**Workaround**

Spawn without `fromSnapshot` then reconstruct state via
`agent.save()` calls.

## `MRD-CF-EX-003` — `SpawnConfig.permissions` dropped

**Category:** `unavailable` (HTTP 503) · **Retryable:** no

Spawn with a `permissions: PermissionScope` field logs a warning and
drops the scope silently. `AuthPlugin` lands in v0.1.5 with real
enforcement.

This is the only `EX-*` code that **doesn't throw** — it's a
warning-only path so existing adopter code that sets permissions
doesn't break during the v0.1 window. When you upgrade to v0.1.5,
the same permissions start enforcing without code changes.

## `MRD-CF-EX-004` — `setPermissions` unavailable

**Category:** `unavailable` (HTTP 503) · **Retryable:** no

`agent.setPermissions(...)` throws. Paired with EX-003 — both
activate in v0.1.5.

## `MRD-CF-EX-005` — `getPermissions` unavailable

**Category:** `unavailable` (HTTP 503) · **Retryable:** no

`agent.getPermissions()` throws. Paired with EX-004.
