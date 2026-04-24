---
"@loom-loyalty/meridian-types": patch
"@loom-loyalty/meridian-wire": patch
"@loom-loyalty/meridian-priority-reference": patch
"@loom-loyalty/meridian-conformance": patch
"@loom-loyalty/meridian-runtime-cloudflare": patch
"@loom-loyalty/meridian-cli": patch
---

No-op patch to exercise the fixed OIDC publish path.

The Release workflow's publish job now uses Node 24 (which ships
npm 11.x natively) instead of attempting to upgrade Node 22's
bundled npm 10.x in place. The in-place upgrade path hit a
`Cannot find module 'promise-retry'` race on the GH runner
that --force didn't resolve.

After this lands, every `@loom-loyalty/meridian-*` package gets
published with signed provenance via the full Trusted Publishers
OIDC pipeline.
