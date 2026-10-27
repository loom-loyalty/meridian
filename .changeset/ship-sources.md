---
"@loom-loyalty/meridian-cli": patch
"@loom-loyalty/meridian-conformance": patch
"@loom-loyalty/meridian-priority-reference": patch
"@loom-loyalty/meridian-runtime-cloudflare": patch
"@loom-loyalty/meridian-types": patch
"@loom-loyalty/meridian-wire": patch
---

Publish `src/` alongside `dist/`. The emitted `.js.map` and `.d.ts.map`
files point at `../src/*.ts`, which wasn't in the tarball, so stack traces
and "go to definition" in adopters' editors resolved to missing files.
