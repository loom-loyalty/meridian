# `MRD-CF-SC-*` — Scheduling errors

One-shot + cron scheduling errors. See [RUNTIME-SPEC §4.3](../../specs/core/RUNTIME-SPEC.md#43-scheduling).

## `MRD-CF-SC-001` — schedule delay below 1 second

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

`scheduleAt(when)` where `when - Date.now() < 1000ms`. Bound per
RUNTIME-SPEC §4.3.

**Fix**

For near-immediate work, do the work synchronously in the calling
handler or use `ctx.waitUntil(...)` to fire it after the response.
`scheduleAt` is for future work at least 1 second out.

## `MRD-CF-SC-002` — schedule delay above 365 days

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

`scheduleAt(when)` where `when - Date.now() > 365 * 24 * 60 * 60 * 1000ms`.
Applies to `scheduleCron` too: the first-fire-time must land within
365 days. Bound per RUNTIME-SPEC §4.3.

**Fix**

Re-schedule from within the fire handler (chain a new `scheduleAt`
at the end of each fire), or use a cron pattern that lands within a
year.

## `MRD-CF-SC-003` — invalid cron pattern

**Category:** `invalid_argument` (HTTP 400) · **Retryable:** no

`scheduleCron(pattern)` rejected by the `croner` parser. Meridian
uses standard 5-field cron (minute, hour, day-of-month, month,
day-of-week). No seconds field, no `@yearly` / `@hourly` aliases.

**Fix**

Rewrite as a 5-field cron. Examples:

- `*/5 * * * *` — every 5 minutes
- `0 0 * * *` — daily midnight
- `*/15 * * * *` — every 15 minutes

## `MRD-CF-SC-004` — scheduleId not found on cancel

**Category:** `not_found` (HTTP 404) · **Retryable:** no

`cancelSchedule(scheduleId)` where the id isn't in this agent's
schedule list. Either already fired + acked, already cancelled, or
never existed.

**Fix**

Check `listSchedules()` before cancelling, or silently ignore this
error if your logic doesn't care whether the schedule was still
pending.
