---
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M2b: scheduling primitive (DO alarms + multi-schedule queue + cron
coalescing on resume).

**Ships:**

- `CfSchedulingPlugin` implementing the `SchedulingPlugin` seam:
  `scheduleAt`, `scheduleCron`, `cancel`, `listSchedules`, `onAlarm`.
- `AgentDurableObject.alarm()` override hooks the plugin into the DO's
  lifecycle so the scheduled alarm actually fires.
- `croner` dependency for cron parsing (eng-review decision: DST-aware,
  zero deps, runs in Workers).
- Stable error codes `MRD-CF-SC-001/002/003/004` for delay bounds, cron
  parse errors, and unknown-id cancels.
- `drainFiredSchedules()` RPC surface (pull-and-clear log of fires).
  M2c replaces this polling with direct `onSchedule` hook invocation
  on the user's AgentSpec.

**Design:**

- Many schedules per agent, ONE DO alarm. Plugin always programs the
  alarm to the earliest `nextFireAt`; when it fires, every due
  schedule is processed in one pass.
- Once-schedules drop off the list post-fire. Cron schedules advance
  `nextFireAt` to the strictly-future next tick.
- Coalescing: when the DO has been offline through N cron ticks, the
  plugin fires ONCE with `coalescedTicks = N` rather than firing N
  times. Advances `nextFireAt` past all missed ticks to the next
  future fire. Matches the RUNTIME-SPEC §4.3 "cron coalescing on
  resume" obligation.
- Delay bounds enforced per spec: ≥ 1 second, ≤ 365 days.

**Tests (10 new, all green):**

- scheduleAt < 1s rejected (MRD-CF-SC-001)
- scheduleAt > 365d rejected (MRD-CF-SC-002)
- Invalid cron pattern rejected (MRD-CF-SC-003)
- Unknown cancel id rejected (MRD-CF-SC-004)
- scheduleAt + listSchedules round-trip
- cancel removes pending schedule
- Once-schedule fires via `runDurableObjectAlarm` + 1.2s real-time
  wait; appended to fired log with `coalescedTicks: 1`
- Multiple due schedules fire in one alarm pass; not-yet-due remains
- **Cron coalescing**: seed a schedule with `nextFireAt` 10 minutes in
  the past via `runInDurableObject`, trigger alarm, assert
  `coalescedTicks` is 9-12 (every-minute cron) and the schedule's
  new `nextFireAt` is strictly future
- Scheduling methods all require spawn (MRD-CF-LC-002)

**Not in M2b (scheduled for M2c):**

- `onSchedule` hook wiring via `defineAgent` (replaces the polling
  `drainFiredSchedules()` surface)
- Transport mailbox refactor + broadcast
