---
"@loom-loyalty/meridian-runtime-cloudflare": patch
---

Review-driven fixes from `/review` on cumulative M2c+M2d state.
Adversarial pass (22+ findings). Ten auto-fixes landed as
auto-corrections during the review and are described under
"Auto-fixes" below. Three bigger items were reshaped as Accepted
ASK items and landed here as A1 / A2 / A3.

**Auto-fixes (during-review corrections)**

- **Transport: atomic partition record** (`cf-transport.ts`). Mail
  inbox and per-sender sequence counter now live in ONE storage
  value under `__mail::${fromAgentId}` (`MailPartition {inbox,
  nextSeq}`). The prior two-key design had a crash window where a
  `put(inbox)` could succeed before `put(seq)` and produce duplicate
  messageIds on retry. Single-key record is atomic by construction —
  no `blockConcurrencyWhile` needed (and `blockConcurrencyWhile`
  throwing shuts down the DO, which made the earlier attempt
  brittle).
- **Transport: cap check BEFORE seq allocation**. Sending to a full
  partition no longer burns a sequence number.
- **Transport: numeric tie-break in `sortMailbox`**. Messages with
  equal `receivedAt` now tie-break by numeric sequence, not
  lexicographic messageId (which was wrong — `sender::10 <
  sender::2` under string sort).
- **Transport: `drainAll` preserves `nextSeq` across drains**. The
  inbox array empties but the counter stays so later deliveries
  from the same sender don't reset to 1 and collide with already-
  delivered messageIds on the receipt path.
- **Resources: `limitHandlers` is now an array, not a single slot**.
  Prior code silently replaced any previously-registered handler
  on each `onLimitEvent(fn)` call. Libraries composing on top of
  the plugin would blow each other's handlers away. Each handler
  is independently try/caught so one bad handler can't take
  siblings down.
- **Resources: `endOperation` guards against post-terminate
  writes**. Sets a `__terminated__` sentinel on wipe; the
  closure-captured end function checks it before writing the CPU
  counter so an orphan write can't reappear on a freshly respawned
  DO.
- **Resources: batched `getUsage`**. One `ctx.storage.get([keys])`
  for the full usage snapshot instead of four sequential reads
  (avoids a torn snapshot from concurrent reportTokens/reportCost
  across the DO input gate boundary).
- **Observability: `CloudflareAnalyticsPlugin` blob budget +
  drop-counter**. Per-point blobs capped at 20 entries × 200 bytes
  (Analytics Engine ~5120 byte total). Overflow triggers a
  `meridian.obs.drops` self-metric so adopters see when
  cardinality exceeds their budget. `writeDataPoint` wrapped in
  try/catch per spec §4.6 (emission MUST NOT throw into the hook
  path).
- **Observability: `CloudflareLogsPlugin.log()` wraps JSON.stringify
  in try/catch** with a string-fallback path. Circular references
  or unserializable payloads can't crash a hook that logs them.
- **Resources: `warnings` docstring + bounded emission**. Clarified
  that the `warnings` array caps at one entry per resource type —
  we overwrite rather than append on repeat crossings so the array
  stays bounded regardless of how many report* calls cross the
  threshold.


**A1 — Per-workItemId attribution surface** (`MRD-CF-RS`)

`reportTokens` / `reportCost` accepted a `{workItemId}` attribution
hint but silently dropped it. RUNTIME-SPEC §4.5 mandates a
retrievable per-workItemId breakdown, not just an agent-total
rollup.

- `cf-resources.ts` now writes per-workItem counters under
  `__usage_wi_tokens::${wid}` / `__usage_wi_cost::${wid}` keys
  alongside the agent-total rollup (double-entry, not either-or).
- New `getUsageByWorkItem(workItemId?)` on `ResourcesPlugin`,
  `AgentContext.resources`, and `AgentDurableObject` RPC. Returns
  `Array<{workItemId, tokens, costUsd}>` sorted by cost descending.
  Omit the arg for the full breakdown; pass an id for single-entry
  lookup. Unattributed reports do not appear as a phantom row.
- Sub-1-second per spec §4.5 (direct DO storage reads via
  `ctx.storage.list({prefix})`, not Analytics Engine round-trip).

**A2 — At-least-once onSchedule via peek + ack** (RUNTIME-SPEC §4.3)

Prior M2d draft drained the fired-schedule log all-at-once before
invoking `onSchedule`, meaning a DO crash mid-hook silently lost
the fire. This violated the at-least-once contract.

- `CfSchedulingPlugin` adds `peekNextFire()` and `ackFire(fireId)`
  alongside the existing `drainFiredSchedules()` polling companion.
- `AgentDurableObject.invokeOnScheduleForFires` now uses a
  peek → invoke → ack loop. Ack lands AFTER the hook completes
  (success OR caught throw). If the DO crashes between peek and
  ack, the fire stays in the log and the next alarm replays it.
- Adopter-code errors inside `onSchedule` still count as delivered
  (we catch and route to the hook-error surface — see A3); only
  actual DO crashes trigger redelivery.
- `drainFiredSchedules()` stays as the polling API for adopters
  who prefer batch semantics.

**A3 — Hook-error observability surface**

Throws in adopter hooks previously ended in a `console.warn` that
never surfaced through the structured observability pipeline.
Adopters had no programmatic way to detect "my hook is broken."

- New `emitHookError(hookName, handle, err, extraFields?)` helper
  on `AgentDurableObject` wired into all five hook catch sites:
  `onSpawn`, `onMessage`, `onSchedule`, `onTerminate`, and the
  `LimitEventHandler` throws routed through
  `CfResourcesPlugin.onHandlerError`.
- Emits `obs.metric("meridian.hook.errors", 1, {hook, agentId,
  domain, errorCode?})` with auto-dimensions merged.
- Emits `obs.log({level:"error", ...})` with ErrorFeedback-shaped
  fields (`tier:"required"`, `type:"error"`,
  `category:"hook_error:${hookName}"`, `severity:"medium"`,
  `frequency:"first"`, `blastRadius:"internal"`, `recovered:true`).
  Observability backends that forward to a FeedbackSignal channel
  see spec-compliant data.
- Both emits are try/caught per RUNTIME-SPEC §4.6 (observability
  emission is non-blocking; a broken obs sink cannot cascade into
  the hook's RPC caller).
- `CfResourcesPlugin` accepts a new optional
  `CfResourcesPluginOptions.onHandlerError` callback at
  construction — the hosting DO wires it; standalone plugin tests
  fall back to the prior `console.warn` path.

**Test changes (+8 runtime-cloudflare, 84 total in package)**

- `resources.test.ts` (+2): per-workItemId attribution with mixed
  attributed/unattributed reports; `getUsageByWorkItem()` before
  any attributed report returns `[]`.
- `scheduling.test.ts` (+2): peek without consume; ack by id
  removes one; crash-simulated replay where the fire survives
  a peek without ack.
- `hooks.test.ts` (+4): `onSpawn` / `onMessage` / `onSchedule` /
  `onTerminate` throwing hooks — each RPC resolves, DO stays
  usable, `hook_error:${name}` + raw error message both appear in
  the captured `console.error` output (proves the structured
  obs.log path fires).
- `transport.test.ts`: spec-tightening. The cross-sender
  interleave assertion was over-asserting — RUNTIME-SPEC §4.4
  only guarantees per-pair ordering, and workerd's Date.now()
  can return the same ms for rapid sequential sends, so the
  lexicographic tie-break on `fromAgentId` can cluster by sender.
  Test now asserts the spec invariant (per-pair order + full set
  of messages) not the cross-sender interleaving.

**Public API additions**

From `@loom-loyalty/meridian-runtime-cloudflare`:

- `AgentContext.resources.getUsageByWorkItem()`
- `AgentDurableObject.getUsageByWorkItem()` RPC
- `CfResourcesPluginOptions` (internal plugin constructor shape —
  not re-exported; documented for parity)

No breaking changes. `CfResourcesPlugin` constructor's new second
argument is optional.
