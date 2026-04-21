# CLAUDE.md

## Project overview

Meridian is the open protocol for agentic systems. It defines how agents, humans, and infrastructure communicate, report state, and participate in a shared feedback loop.

This is a TypeScript monorepo managed with pnpm workspaces and Turborepo.

## Repository structure

- `specs/` — protocol specification documents (CC BY 4.0). Source of truth for all type definitions.
- `packages/types/` — `@loom-loyalty/meridian-types`. Shared TypeScript types. Every other package imports from here.
- `packages/wire/` — `@loom-loyalty/meridian-wire`. MessagePack/WebSocket wire protocol implementation.
- `packages/runtime-cloudflare/` — reference runtime adapter for Cloudflare Workers + Durable Objects (planned).
- `packages/conformance/` — runtime conformance test suite (planned).
- `packages/integration-proxy/` — credential brokering proxy (planned).
- `examples/` — working examples demonstrating the types and wire protocol.

## Commands

```bash
pnpm install          # install all dependencies
pnpm build            # build all packages (respects dependency order via turbo)
pnpm test             # run all tests
pnpm typecheck        # type-check all packages
pnpm format           # format with prettier
pnpm format:check     # check formatting without writing
```

## Architecture decisions

### Wire protocol
Agent-to-agent communication uses MessagePack frames over WebSocket. The `wire` package handles encoding/decoding. Frame headers use short keys (`v`, `t`, `id`, `from`, `to`, `domain`, `cor`, `wi`, `ts`, `ttl`, `pri`) to minimize wire size. At LLM injection boundaries, payloads decode to minified JSON via `payloadToJSON()`.

### Types package is the contract
The `types` package is the single source of truth. It mirrors the spec documents. If the spec says something, there's a corresponding type. If there's no type, the spec doesn't say it. Changes to types require corresponding spec updates and vice versa.

### Runtime spec primitives
The spec defines six primitives that any platform must implement: agent lifecycle (spawn/suspend/resume/terminate), state persistence (key-value with atomic updates), scheduling (one-shot and cron), message transport (send/broadcast/onMessage), resource limits (CPU/memory/tokens/cost enforcement), and observability (logs/metrics/traces).

### Experimental features
Types marked `@experimental` may change in minor versions. Currently experimental: `PermissionScope`, `InvocationContext`, `SnapshotId`, `RuntimeRequirements`, `QualitySignal`, `EnforcementTier`, `CompetingContext`. Stable types are frozen for the v1.x line.

## Coding conventions

- TypeScript strict mode, always
- ESM only (`"type": "module"` in all package.json files)
- Use `.js` extensions in import paths (TypeScript ESM requirement)
- Export types from `packages/types/`, never from individual packages
- Every exported function and type gets a JSDoc comment
- No default exports (named exports only)
- Prefer `interface` over `type` for object shapes
- Prefer `unknown` over `any`
- Use `Uint8Array` for binary data, never `Buffer`

## Key types to know

- `AgentId`, `DomainId`, `WorkItemId` — string identifiers
- `Frame` / `FrameHeader` — wire protocol message structure
- `FeedbackSignal` — union of all feedback types (heartbeat, cost, error, metric, insight, etc.)
- `QualitySignal` — structured quality validation results with enforcement tiers
- `CompetingContext` — machine-readable counter-evidence for priority scoring (see `specs/patterns/PRIORITY-ENGINE-SPEC.md`)
- `WorkItem` — unit of work with two cost estimates (cost to build, cost of NOT building)
- `PermissionScope` — what services/methods an agent can access (experimental)

## What not to do

- Don't break backward compatibility on stable types within v1.x.
- Don't use JSON for agent-to-agent communication. MessagePack over WebSocket is the wire format.
- Don't put credentials in agent environments. Use the integration proxy pattern.
- Don't create circular dependencies between packages. Types depends on nothing. Wire depends on types. Everything else depends on types.
