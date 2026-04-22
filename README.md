# Meridian

[![CI](https://github.com/loom-loyalty/meridian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/loom-loyalty/meridian/actions/workflows/ci.yml)
[![E2E (Cloudflare)](https://github.com/loom-loyalty/meridian/actions/workflows/e2e-cloudflare.yml/badge.svg?branch=main)](https://github.com/loom-loyalty/meridian/actions/workflows/e2e-cloudflare.yml)

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

Stewarded by [Loom Loyalty](https://github.com/loom-loyalty). Licensed under Apache 2.0 (code) and CC BY 4.0 (specs).

The **E2E (Cloudflare)** badge above means the full runtime conformance suite runs against a real Cloudflare Workers deployment on every push to `main` — not a local emulator. If it's green, the reference adapter passes all applicable conformance scenarios on the platform it targets.

---

## What Meridian defines

Meridian is split into a protocol-shaped core and a set of opinionated operating patterns:

**Core** (`specs/core/`) — any implementation claiming Meridian conformance implements these primitives.

1. **Wire protocol** — MessagePack frames over WebSocket, frame header shape, message types, agent discovery
2. **Runtime primitives** — lifecycle, state, scheduling, message transport, resource limits, observability
3. **Feedback contract** — envelope, tier classification, required + expected signal types
4. **Skill declaration** — three-stage progressive disclosure for agent capabilities

**Operating patterns** (`specs/patterns/`) — the opinionated layer Loom Loyalty uses. Not required for core conformance, but what makes Meridian distinctive.

5. **Domain model** — organizational primitives based on accountability, with human stewards who own budget, gates, and direction
6. **Work item schema** — every unit of work carries two cost estimates (cost to build, cost of NOT building) in real dollars
7. **Feedback processing** — optional-tier signals (quality, competing context, pattern recognition) plus routing, conflict resolution, deduplication, cooldown, and graduated enforcement (mechanical → agent review → human gate)

A priority engine spec (`specs/patterns/PRIORITY-ENGINE-SPEC.md`) lands in v1.0-draft.5 along with a reference implementation at `@loom-loyalty/meridian-priority-reference`.

## Wire protocol

Meridian agent-to-agent communication uses **MessagePack frames over WebSocket**. Each frame contains a header (message type, source/target agent IDs, domain ID, correlation ID) and an opaque payload. At LLM injection boundaries, frames decode to minified JSON.

Agent discovery uses **Agent Cards** served at `/.well-known/agent-card.json`. Agent-to-tool communication supports **MCP** for compatibility with the existing tool ecosystem.

## Repository structure

```
meridian/
├── specs/                                # Protocol specifications (CC BY 4.0)
│   ├── README.md                         # Reading order
│   ├── MERIDIAN-IN-PRACTICE.md           # Narrative walkthrough
│   ├── core/
│   │   ├── README.md
│   │   ├── WIRE-PROTOCOL-SPEC.md         # Wire format specification
│   │   ├── RUNTIME-SPEC.md               # Runtime primitive contract
│   │   ├── FEEDBACK-SPEC.md              # Feedback envelope + required/expected tiers
│   │   └── SKILL-SPEC.md                 # Skill declaration
│   └── patterns/
│       ├── README.md
│       ├── DOMAIN-SPEC.md                # Domain model
│       ├── WORK-ITEM-SPEC.md             # Work item schema
│       └── FEEDBACK-PROCESSING-SPEC.md   # Optional-tier signals + processing
│
├── packages/
│   ├── types/                            # @loom-loyalty/meridian-types
│   │   └── src/
│   │       ├── primitives.ts             # Runtime primitive interfaces
│   │       ├── runtime.ts                # Runtime interface declarations
│   │       ├── feedback.ts               # Feedback contract types
│   │       ├── work-item.ts              # Work item schema types
│   │       ├── domain.ts                 # Domain model types
│   │       ├── wire.ts                   # Wire protocol frame types
│   │       ├── quality.ts                # Quality signal, enforcement tier, competing context
│   │       ├── permissions.ts            # PermissionScope, InvocationContext
│   │       ├── errors.ts                 # RuntimeError, ErrorCategory
│   │       └── index.ts
│   │
│   └── wire/                             # @loom-loyalty/meridian-wire
│       └── src/
│           ├── codec.ts                  # MessagePack encode/decode
│           ├── frame.ts                  # Frame header/payload structure
│           ├── websocket.ts              # WebSocket transport layer
│           └── index.ts
│
├── examples/
│   └── hello-agent/                      # Minimal agent example
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── LICENSE                               # Apache 2.0
├── LICENSE-SPECS                         # CC BY 4.0 (specs only)
└── README.md                             # This file
```

## Getting started

```bash
git clone https://github.com/loom-loyalty/meridian.git
cd meridian
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

### Setup notes

The project pins `pnpm@9.15.0` via the `packageManager` field and requires Node 22+ (pinned via `.nvmrc`). Node 22 is the current active LTS through April 2027. CI runs on Node 22.

Non-LTS Node releases (21, 23, 25) are "Current" line and are not officially supported by most tooling in the JS ecosystem. `npm` warns `EBADENGINE` on the latest `corepack`, `pnpm` may hit a bundled-corepack signature-verification bug, and any number of transitive deps will flake in ways you can't fix in this repo.

If you are stuck on non-LTS Node for some other reason and `pnpm install` fails with `Cannot find matching keyid`, this env var works around the corepack signature issue by using the pinned `packageManager` version directly:

```bash
COREPACK_DEFAULT_TO_LATEST=0 pnpm install
```

Export it in your shell rc (`.zshrc`, `.bashrc`) to make it permanent. CI runs fine without it.

### Contributing

Package changes need a changeset:

```bash
pnpm changeset
```

See [`.changeset/README.md`](.changeset/README.md) for the release workflow. Spec-only changes (files under `specs/`) do not require a changeset.

## Packages

Everything below is published to npm under `@loom-loyalty/*`.

| Package                                     | Description                                                         | Status                |
| ------------------------------------------- | ------------------------------------------------------------------- | --------------------- |
| `@loom-loyalty/meridian-types`              | Shared TypeScript types from the spec                               | v0.1 (pre-1.0)        |
| `@loom-loyalty/meridian-wire`               | MessagePack/WebSocket wire protocol                                 | v0.1 (pre-1.0)        |
| `@loom-loyalty/meridian-priority-reference` | Reference priority engine (WSJF-derived formula + circuit breaker)  | v0.1 (pre-1.0)        |
| `@loom-loyalty/meridian-runtime-cloudflare` | Cloudflare Workers + Durable Objects runtime adapter                | v0.1 (verified on CF) |
| `@loom-loyalty/meridian-conformance`        | Runtime + priority conformance test suite                           | v0.1 (pre-1.0)        |
| `@loom-loyalty/meridian-cli`                | `meridian init / gen-token / demo / doctor / inspect / domains` CLI | v0.1 (pre-1.0)        |

## Roadmap

Remaining packages on the v1.0 track:

| Package                        | Description                            | Target |
| ------------------------------ | -------------------------------------- | ------ |
| `@loom-loyalty/meridian-proxy` | Credential brokering integration proxy | v1.0   |

Runtime milestones: M4 (auth + admin + CLI) shipped. Next: M6 tenancy depth, M7 docs + agent-card polish.

## Related projects

- **[Harness Engineering](https://github.com/Intense-Visions/harness-engineering)** — Quality enforcement framework. Meridian-compatible integration for mechanical constraints, entropy detection, and agent feedback loops.

## Status

Meridian is in active development. The runtime spec is at v1.0.0-draft.3. The wire protocol spec is at v1.0.0-draft.1. The full v1.0 set is targeting draft.4 for the structural cleanup landing with this PR, then draft.5 for the priority engine + reference implementation.

This is pre-1.0 software. APIs will change. We welcome feedback via issues and pull requests.

## License

Code: [Apache 2.0](LICENSE)
Specifications: [CC BY 4.0](LICENSE-SPECS)
