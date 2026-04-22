# Error Catalog — `MRD-CF-*`

Every `RuntimeError` from `@loom-loyalty/meridian-runtime-cloudflare`
carries a stable code of the form `MRD-CF-<primitive>-<nnn>` and a
`docUrl` pointing at the matching page here. Adopters pattern-match
on the code for recovery logic without parsing error messages.

**Codes are stable within a major version.** New codes append; retired
codes are never reused or renumbered. Breaking changes bump major.

## By primitive

| Prefix        | Primitive                       | Count |
| ------------- | ------------------------------- | ----: |
| `MRD-CF-LC-*` | [Lifecycle](lifecycle.md)       |     5 |
| `MRD-CF-ST-*` | [State](state.md)               |     3 |
| `MRD-CF-SC-*` | [Scheduling](scheduling.md)     |     4 |
| `MRD-CF-TR-*` | [Transport](transport.md)       |     3 |
| `MRD-CF-RS-*` | [Resources](resources.md)       |     4 |
| `MRD-CF-EX-*` | [Experimental](experimental.md) |     5 |
| `MRD-CF-AU-*` | [Auth](auth.md)                 |     3 |

**Total: 27 codes.** All map to HTTP status codes via `ErrorCategory`.

## Error envelope

When a `MRD-CF-*` error crosses the HTTP surface (any `/agents/*` or
`/admin/*` route), the response body is:

```json
{
  "error": {
    "code": "MRD-CF-LC-001",
    "category": "already_exists",
    "message": "[MRD-CF-LC-001] existing agent X/Y on this DO; ...",
    "retryable": false,
    "docUrl": "https://meridianprotocol.dev/errors/MRD-CF-LC-001",
    "context": { ... }
  }
}
```

HTTP status derives from `category`:

| `category`           | HTTP |
| -------------------- | ---: |
| `invalid_argument`   |  400 |
| `unauthenticated`    |  401 |
| `permission_denied`  |  403 |
| `not_found`          |  404 |
| `already_exists`     |  409 |
| `resource_exhausted` |  429 |
| `internal`           |  500 |
| `unavailable`        |  503 |

## Pattern-matching on codes

```ts
import {
  errorCode,
  isMeridianError,
} from "@loom-loyalty/meridian-runtime-cloudflare";

try {
  await agent.spawn(config);
} catch (err) {
  if (isMeridianError(err) && errorCode(err) === "MRD-CF-LC-001") {
    // Handle the "re-spawn with different identity" case.
  }
  throw err;
}
```

`isMeridianError` + `errorCode` work on both in-isolate errors and
errors that crossed a Durable Object RPC boundary (where CF strips
the `RuntimeError` class identity). The helpers parse the
`[MRD-CF-XX-NNN]` prefix from the message as a fallback.

## Retry semantics

`retryable: true` errors are safe to retry after backoff:

- `MRD-CF-TR-003` — inbox partition full
- `MRD-CF-RS-004` — concurrency cap reached

Everything else is a permanent failure against the current state;
retrying without changing inputs will hit the same error.
