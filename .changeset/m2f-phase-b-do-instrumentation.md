---
"@loom-loyalty/meridian-runtime-cloudflare": patch
---

M2f Phase B: DO RPC error surfacing for real-CF flake diagnosis.

Real-CF runs of the M2e conformance suite surfaced an intermittent
failure pattern: ~1 run in 3-4 produces `"internal error; reference=
XXX"` from a random DO RPC (different scenario each time —
`resources-warnings`, `state-durability`, `transport-broadcast` have
all taken turns). Cloudflare's DO RPC collapses non-standard throws
into that opaque string at the caller side and drops the DO-side
stack frames, so the only visible signal was a useless reference ID.

**Fix: cross-cutting `logRpcError` wrapper**

- New `log-rpc-error.ts` — single helper that catches any throw
  inside a DO RPC method body and `console.error`s the constructor
  name, error code, message, cause chain, and full stack BEFORE
  re-throwing.
- `AgentDurableObject`: every public RPC method + the `alarm()`
  handler now wraps its body in `logRpcError("method", async () =>
  { ... })`. 25 wrapped entry points.
- `RegistryDurableObject`: same treatment for `register`,
  `unregister`, `lookup`, `list`.

**What this buys us**

Workers Logs (via Cloudflare dashboard) and `wrangler tail`
streaming (the E2E workflow captures this) now see the originating
stack with its MRD-CF-* code and plugin / primitive-level frames.
Next time the real-CF suite flakes, the tail output will show
exactly which plugin threw what, instead of the CF-wrapped
reference ID.

**Trade-off: log noise from expected throws**

Scenarios that intentionally trigger MRD-CF-* throws (via
`expectReject`) now produce a `console.error` line per rejection.
That's ~15-25 lines per conformance invocation. Adopters who want
a quieter surface can filter by `code` starts-with `MRD-CF-` and
route known errors to a lower severity. We chose uniform logging
over conditional filtering so there's one log format and no "did
this pass through the wrapper" uncertainty.

**Test totals**

- `runtime-cloudflare/test/`: 87/87 tests still green. The wrapping
  is transparent to callers — same return values, same thrown error
  types, just an added log line on throw.

**Next**

If real-CF still flakes after this lands, the tail output will name
the plugin / primitive. At that point the fix is localized (not
speculative). If the flake disappears on retry but only when
observable this way, the wrapping itself might be sufficient (the
act of catching may change JIT / input-gate behavior enough to
avoid the race).
