---
"@loom-loyalty/meridian-runtime-cloudflare": minor
---

M3a: `createMeridianWorker` HTTP entrypoint — the adopter-facing
helper that makes a single-file Worker out of an agent list.

Replaces the M1 walking-skeleton stub (`return 501 Not Implemented`
for every route) with a real minimal REST surface. This is what
adopters have been writing themselves in ~20 lines of bespoke fetch
handler (the pattern visible in the prior `test/test-worker.ts`);
shipping it as a helper keeps every adopter on the same HTTP
contract and unblocks M3b/M3c example agents.

**HTTP surface**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Health (`{runtime, healthy}`) |
| `GET` | `/.well-known/agent-card.json` | A2A-shaped discovery |
| `POST` | `/agents/:id/spawn` | `{domain}` → AgentHandle, 201 |
| `GET` | `/agents/:id` | AgentHandle |
| `DELETE` | `/agents/:id` | Terminate, 204 |
| `POST` | `/agents/:id/messages` | `{to, payload: base64}` → MessageReceipt, 202 |
| `POST` | `/agents/:id/broadcast` | `{selector?, payload: base64}` → BroadcastReceipt, 202 |
| `GET` | `/agents/:id/inbox` | `{messages: IncomingMessage[]}` snapshot |
| `POST` | `/agents/:id/inbox/drain` | `{messages: IncomingMessage[]}` pull-and-clear |

Every route delegates to `env.AGENT` DO RPCs — no work in the Worker
itself beyond request parsing + response shaping. JSON bodies base64-
encode `Uint8Array` payloads for wire compatibility.

**Error shaping**

MRD-CF-\* throws surface as
`{error: {code, category, message, retryable, docUrl, context?}}`
with HTTP status mapped from `ErrorCategory`:

- `invalid_argument` → 400
- `unauthenticated` → 401
- `permission_denied` → 403
- `not_found` → 404
- `already_exists` / `aborted` → 409
- `failed_precondition` → 412
- `resource_exhausted` → 429
- `unavailable` → 503
- `deadline_exceeded` → 504
- `internal` / unmapped → 500

The DO RPC boundary reconstructs thrown errors as plain `Error`
(stripping `RuntimeError` class identity), so the helper also parses
the `[MRD-CF-XX-NNN]` prefix off the message and re-hydrates the
category / retryable / docUrl via the new `lookupMeridianCode()`
helper exported from `errors.ts`. `MERIDIAN_ERROR_CODE_RE` is also
exported so adopters can do the same pattern-match client-side.

**Custom routes escape hatch**

`config.routes: Record<"METHOD /path", Handler>` adds or shadows
routes. The test harness (`test/test-worker.ts`) now uses this to
layer the `GET /conformance` scenario-runner on top of the standard
helper — same helper adopters consume in production, same `/agents/*`
surface, plus one custom route for the E2E workflow.

**No auth in v0.1.** Docstrings + README call this out explicitly.
Adopters MUST restrict via Cloudflare Access / IP allowlist / private
URL until M4 lands bearer auth.

**Other changes**

- `index.ts` — exports `createMeridianWorker`, `MeridianWorkerConfig`,
  `MeridianRouteHandler`, plus `lookupMeridianCode` + `MERIDIAN_ERROR_CODE_RE`
  from errors.
- `errors.ts` — new `lookupMeridianCode(code)` and `MERIDIAN_ERROR_CODE_RE`.
- `README.md` — replaces the stale "Usage (preview)" section with the
  actual shipped API + a minimum-viable-worker walkthrough.
- `test/test-worker.ts` — refactored to use the helper (dogfood).
- `.github/workflows/e2e-cloudflare.yml` — smoke check now asserts
  `.healthy == true` instead of the old `milestone` field (which the
  helper doesn't include).
- `test/worker-routes.test.ts` — new, 12 HTTP-surface tests covering
  every built-in route plus custom-route precedence.

**Test totals**

- 87 → 99 tests green in `runtime-cloudflare` package.
- Conformance suite unchanged (already covers the underlying RPCs).

**Next**

M3b (`cf-hyperdrive-postgres` native-CF example) and M3c
(`docker-kafka` interop example) build on this helper.
