# Meridian Docs

Companion documentation for the [Meridian protocol](../specs/README.md).
The specs in `../specs/` are the canonical contract. This directory
is adopter-facing — guides, troubleshooting, and the error catalog
that ship alongside the reference implementations.

## Quickstarts

- [**`defineAgent()` quickstart**](guides/define-agent-quickstart.md) — 10-line agent on
  Cloudflare Workers, walked line by line
- [**`meridian doctor` troubleshooting**](guides/doctor-troubleshooting.md) — what every
  check means and how to fix a `FAIL` result
- [**AgentCard `securitySchemes`**](guides/agent-card-security-schemes.md) — how
  `/.well-known/agent-card.json` advertises auth
- [**Tenancy invariants**](guides/tenancy-invariants.md) — what the runtime
  enforces when `createMeridianWorker({tenancy})` is configured

## Error catalog

Every `RuntimeError` from `@loom-loyalty/meridian-runtime-cloudflare`
carries a stable `MRD-CF-*` code and a `docUrl` pointing at one of
these pages. Adopters can pattern-match on the code in their own
error handlers. **Codes are stable within a major version** —
breaking changes bump major.

See the [error catalog index](errors/README.md).

## Contributing

Doc changes don't need a changeset. If a doc references a specific
runtime version or an error code, keep it in sync with `packages/*`
when you bump.
