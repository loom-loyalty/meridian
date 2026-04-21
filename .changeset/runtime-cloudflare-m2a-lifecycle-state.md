---
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M2a: extract plugin seams, complete lifecycle + state primitives, ship
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
