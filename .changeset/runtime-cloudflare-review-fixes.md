---
"@loom-loyalty/meridian-runtime-cloudflare": patch
---

Review-driven fixes from `/review` on cumulative M0-M2b state.

**Security (critical)**

- Sender-identity spoofing guard at spawn time. `spawn()` now rejects
  with `MRD-CF-LC-005` if `config.id` doesn't hash to the same DO id
  (`env.AGENT.idFromName(config.id).toString() === ctx.id.toString()`).
  Prior to this check, an adopter could spawn DO `alice` with
  `{id: "bob"}` and `sendTo` would stamp the forged sender as "bob"
  on recipient inboxes. Category: `permission_denied`.
- E2E workflow label trigger restricted to in-repo PRs only. Fork
  contributors can no longer apply `e2e-cloudflare` to execute
  arbitrary worker code with the CF secrets.

**Reliability**

- `CfSchedulingPlugin.onAlarm` coalesce loop bounded at
  `MAX_COALESCE_ITERATIONS = 10_000` to prevent a dense cron
  (e.g. `* * * * *`) offline for long windows from spinning past
  the 30s CPU envelope.
- `onAlarm` wraps `new Cron(s.cron!)` in try/catch. A single
  corrupted or newly-invalid stored pattern can't crash the entire
  alarm handler and starve every other schedule on the agent.
- `scheduleCron` enforces the same 365-day horizon as `scheduleAt`.
  Leap-year patterns like `0 0 29 2 *` can legitimately produce a
  `nextRun` up to 4 years out; now rejected with `MRD-CF-SC-002`.
- `lifecycle.terminate()` explicitly calls `deleteAlarm()` alongside
  `deleteAll()` and accurately documents the ordering (comment was
  backward pre-fix).

**Data flow consistency**

- `RegistryDurableObject` is now wired into the lifecycle:
  `spawn()` calls `register(id, domain)` after persisting meta;
  `terminate()` calls `unregister(id)` before wiping. Uses a single
  `"default"` shard key in v0.1; M2c sharding is an additive change.
  Registry failures are logged but don't fail lifecycle ops (the
  registry is a read-side aid, not a source of truth).
- `CfSchedulingPlugin.listSchedules` no longer peeks into the
  lifecycle plugin's `__meta__` storage directly. Constructor now
  takes an agent-id resolver callback; agent-do wires it to
  `lifecycle.requireMeta().id`.

**API stability**

- `AgentDurableObject.incrementAtomic(key, delta)` promoted to
  stable public API. Documented as the canonical non-function RPC
  shape for atomic updates from outside the DO (the generic
  `update(key, fn)` can't cross structured-clone boundaries).
- `AgentDurableObject.drainFiredSchedules()` promoted to stable
  public API. Batch-poll companion to the `onSchedule` hook landing
  in M2c.

**Tests**

- +2 runtime-cloudflare (LC-005 guard + LC-001 domain-change
  branch). Full suite: 100 green across monorepo (23 conformance
  + 34 priority-reference + 43 runtime-cloudflare).

**Carry-forwards** (flagged by adversarial, scheduled for M2c/M2d):

- Inbox unbounded growth (agent-do.ts deliver) — M2c mailbox
  refactor.
- Fired-log unbounded growth (cf-scheduling.ts onAlarm) — M2d
  observability or M2c alongside onSchedule hook.
- Schedule list 1 MB ceiling — M2c: cap + MRD-CF-SC-005 overflow
  code, or partitioning.
- JSON.stringify vs structured-clone size-check drift for strings
  with lone surrogates — M2d state-plugin hardening.
- `list()` cursor deletion-race semantics — M2d state-plugin docs
  + optional `start + "\0"` successor trick.
- PermissionScope drop emits `console.warn` not a FeedbackSignal —
  M2d observability wiring.
- Missing error codes: MRD-CF-TR-\*, MRD-CF-RS-\*, MRD-CF-OB-\* —
  fill out as M2c/M2d lands each primitive.
