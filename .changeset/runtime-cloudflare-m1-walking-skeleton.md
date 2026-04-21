---
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

Initial 0.1.0 scaffold of `@loom-loyalty/meridian-runtime-cloudflare`:
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
