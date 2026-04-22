---
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M2c: transport primitive + `defineAgent` hooks.

**Transport primitive** (`cf-transport.ts`)

- `TransportPlugin` seam with send / broadcast / deliver / receiveAll
  / drainAll.
- Mailbox layout per the eng-review decision: **one
  AgentDurableObject per recipient, sender-partitioned storage**.
  Keys are `__mail::${fromAgentId}` + `__mail_seq::${fromAgentId}`.
  Per-sender monotonic sequence numbers (encoded in `messageId` as
  `${fromAgentId}::${seq}`) give the RUNTIME-SPEC §4.4
  "at-least-once + in-order per (sender, recipient) pair" guarantee
  without exploding N² DOs.
- 1 MB payload validation at both send and receive boundaries →
  `MRD-CF-TR-001`.
- **Broadcast** via the now-wired RegistryDO: fan-out to agents
  matching `AgentSelector` at call time. Defaults domain filter to
  the sender's own domain when the selector doesn't specify (safe
  default for first-time adopters). `MRD-CF-TR-002` when zero
  recipients match. Late-spawned agents don't receive prior
  broadcasts (spec semantic).
- Fan-out uses `Promise.allSettled` so one failing delivery doesn't
  fail the broadcast; per-recipient failures logged.

**`defineAgent` hooks**

Adopter-facing authoring API — progressive-disclosure hooks that
run INSIDE the DO with full plugin access (the generic
`update(key, fn)` path works here because no structured-clone
boundary is crossed):

- `onSpawn(ctx)` — fires after spawn persists. Seed baselines,
  register defaults, fire a first heartbeat.
- `onMessage(ctx, msg)` — fires after each deliver lands. Hook
  errors don't bubble to the sender.
- `onTerminate(ctx)` — fires before `deleteAll()`. Last chance to
  notify peers or flush external state.

onSchedule lands in M2d alongside observability.

`AgentContext` exposes `state` (save/load/delete/list/update),
`transport` (send/broadcast), and `schedule` (at/cron/cancel). The
hosting DO constructs the context from its own plugins and passes
it to every hook invocation.

**Public API renames** on `AgentDurableObject`:

- `sendTo(to, payload)` → `send(to, payload)` + returns
  `MessageReceipt` (M1 `sendTo` was void; spec shape now honored)
- `receive()` → `receiveAll()` (explicit snapshot semantics)
- Added `drainInbox()` as the pull-and-clear companion
- Added `broadcast(selector, payload)` returning `BroadcastReceipt`

These are breaking-within-a-major for the 0.2.x line; no external
consumers yet.

**Error catalog additions**

- `MRD-CF-TR-001` (invalid_argument) — payload > 1 MB
- `MRD-CF-TR-002` (not_found) — broadcast matched zero recipients

**Tests (+14 runtime-cloudflare, 55 total in package)**

- `transport.test.ts` (7): 1 MB rejection, per-sender sequence
  independence, drainInbox vs receiveAll, intra-domain broadcast,
  cross-domain broadcast via explicit selector, empty-selector
  broadcast rejection, late-spawn non-receipt
- `hooks.test.ts` (5): onSpawn writes state, onMessage records
  deliveries, onTerminate calls transport.send before wipe,
  hooks can call the generic `update(key, fn)`, specless agents
  still work
- Walking-skeleton updated to the new send/receiveAll API + one
  added "per-sender sequence numbers" assertion
- +2 existing from M2b (now verifying against the new transport
  plugin) still pass unchanged

**Not in M2c (scheduled for M2d)**

- Resources primitive (setLimits, getUsage, onLimitEvent, hard
  limits)
- Observability primitive (ObservabilityPlugin exported API +
  CF Analytics + Workers Logs)
- `onSchedule` hook wiring on AgentSpec
- Inbox unbounded-growth cap (depends on M2d resources)
- `FiredSchedule.onSchedule` invocation
