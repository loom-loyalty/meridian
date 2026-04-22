---
"@loom-loyalty/meridian-runtime-cloudflare": patch
---

Change error catalog `docUrl` base from `https://meridian.dev/errors/`
to `https://meridianprotocol.dev/errors/`. The `meridian.dev` domain
wasn't owned by Loom Loyalty; `meridianprotocol.dev` is the canonical
domain for the project (registered 2026-04-22). Error-catalog pages
(M7) will live at `meridianprotocol.dev/errors/<CODE>`.

Touches:

- `DOC_BASE_URL` in `errors.ts`
- Inline `docUrl` template in `create-meridian-worker.ts`'s
  re-hydration path (for errors whose class identity was stripped by
  the DO RPC boundary)
- `test/errors.test.ts` assertions

No behavior change beyond the URL string. 99/99 tests still green.
