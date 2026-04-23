---
"@loom-loyalty/meridian-conformance": patch
---

Retry scenarios that fail with CF's cold-DO error-mask.

Real-CF sometimes wraps DO-thrown `RuntimeError`s as
`"internal error; reference=<hex>"` on the RPC boundary when the
Durable Object is cold. The expected `MRD-CF-*` error is visible in
the DO-side `logRpcError` trace, but callers see the generic mask.
Subsequent calls on the now-warm DO return the true error.

The runner's `isTransientDOError` now matches
`/internal error;\s*reference\s*=\s*[a-z0-9]+/i` in addition to the
existing "Durable Object reset" pattern. Retry budget unchanged at
1 — deterministic failures still fail.

Adopter-facing change: none. If your conformance runs were flaking
on real-CF with CF internal-error references, they will now pass on
the automatic retry. If a scenario fails across both attempts, that
is a real bug; the result + reason surface unchanged.
