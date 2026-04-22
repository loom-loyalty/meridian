---
"@loom-loyalty/meridian-conformance": minor
"@loom-loyalty/meridian-runtime-cloudflare": patch
---

M2f Phase 1: conformance coverage expansion + 2 real-CF adapter bug
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
- `errors-codes-reachable` — every MRD-CF-* code in the stable catalog
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
  RPC (pre-spawn or post-terminate).
  - `walking-skeleton.test.ts` post-terminate `load` assertion updated
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
