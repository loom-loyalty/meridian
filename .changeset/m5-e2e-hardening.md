---
"@loom-loyalty/meridian-conformance": minor
"@loom-loyalty/meridian-runtime-cloudflare": patch
---

M5: E2E CI hardening + verified-on-CF badge.

**New conformance scenario**

`concurrency-spawn-broadcast-fanout` — spawns N=12 agents in the same
domain in parallel, has each broadcast once, then asserts every
recipient's inbox ends with exactly N-1 messages (excludes sender).

Exercises RegistryDO + mailbox DO concurrency under load that no
existing scenario touches — every previous scenario uses a small
fixed set of agents. Applies to all three runtime kinds
(`in-memory`, `miniflare`, `real-cf`) so divergence between them
shows up as a red build on the parity test.

The N=12 fan-out runs ~48 DO RPCs per scenario. Picked to be
meaningful without overrunning the ~30s real-CF Worker CPU budget
under the batched `/conformance` pager.

**Verified-on-CF badge**

Root `README.md` now carries `E2E (Cloudflare)` and `CI` badges. The
E2E badge tracks
`.github/workflows/e2e-cloudflare.yml` on `main` — green means the
full runtime conformance suite (including the new M5 fan-out
scenario) ran against a real Cloudflare Workers deployment on the
latest push, not a Miniflare emulator.

**Packages table refresh**

Every package previously listed under "Roadmap" has shipped. Table
now reflects what's on npm + links the `meridian-cli` scaffolder.
Only `@loom-loyalty/meridian-proxy` remains on the roadmap for v1.0.

**DEPLOY-CI.md refresh**

Documents what the E2E workflow covers today — deploy, smoke probe,
batched conformance runner, `wrangler tail` capture on failure,
conditional teardown. Removes the "what grows in M2" section (all
of that has since landed).

**Test totals**

- `runtime-cloudflare`: 123 → 123 tests green (conformance scenario
  count goes 31 → 32, but the outer test file already runs the full
  `runtimeScenarios` export — no new `it()` block needed).
- `conformance` suite now publishes 32 scenarios total (31 prior +
  1 new concurrency scenario).
