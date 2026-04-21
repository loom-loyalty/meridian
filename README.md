# Meridian

**Where agents, humans, and infrastructure align.**

Meridian is the open protocol for agentic systems. It defines how agents, humans, and infrastructure communicate, report state, and participate in a shared feedback loop that makes the system smarter with every action.

Stewarded by [Loom Loyalty](https://github.com/loom-loyalty). Licensed under Apache 2.0 (code) and CC BY 4.0 (specs).

---

## What Meridian defines

Meridian is a protocol specification with six components:

1. **Feedback contract** — structured tiers (required, expected, optional) for what every component must report: heartbeats, cost, errors, dependencies, metrics, insights, quality signals
2. **Work item schema** — every unit of work carries two cost estimates (cost to build, cost of NOT building) in real dollars, plus domain assignment, confidence, and lineage
3. **Domain model** — organizational primitives based on accountability, not org charts, with human stewards who own budget, gates, and direction
4. **Feedback processing** — routing, conflict resolution, deduplication, cooldown, and graduated enforcement (mechanical → agent review → human gate)
5. **Skill declaration** — three-stage progressive disclosure for agent capabilities, versioning, and marketplace discovery
6. **Runtime spec** — six primitives (lifecycle, state, scheduling, messaging, resource limits, observability) that any platform must implement to host Meridian-compatible agents

## Wire protocol

Meridian agent-to-agent communication uses **MessagePack frames over WebSocket**. Each frame contains a header (message type, source/target agent IDs, domain ID, correlation ID) and an opaque payload. At LLM injection boundaries, frames decode to minified JSON.

Agent discovery uses **Agent Cards** served at `/.well-known/agent-card.json`. Agent-to-tool communication supports **MCP** for compatibility with the existing tool ecosystem.

## Repository structure

```
meridian/
├── specs/                          # Protocol specifications (CC BY 4.0)
│   ├── RUNTIME-SPEC.md             # Runtime primitive contract
│   ├── FEEDBACK-SPEC.md            # Feedback contract (planned)
│   ├── WORK-ITEM-SPEC.md           # Work item schema (planned)
│   ├── DOMAIN-SPEC.md              # Domain model (planned)
│   ├── SKILL-SPEC.md               # Skill declaration (planned)
│   └── WIRE-PROTOCOL.md            # Wire format specification (planned)
│
├── packages/
│   ├── types/                      # @loom-loyalty/meridian-types
│   │   └── src/
│   │       ├── primitives.ts       # Runtime primitive interfaces
│   │       ├── feedback.ts         # Feedback contract types
│   │       ├── work-item.ts        # Work item schema types
│   │       ├── domain.ts           # Domain model types
│   │       ├── wire.ts             # Wire protocol frame types
│   │       ├── quality.ts          # Quality signal, enforcement tier, competing context
│   │       ├── permissions.ts      # PermissionScope, InvocationContext
│   │       ├── errors.ts           # RuntimeError, ErrorCategory
│   │       └── index.ts
│   │
│   ├── runtime-cloudflare/         # @loom-loyalty/meridian-runtime-cloudflare
│   │   └── src/
│   │       ├── agent-do.ts         # AgentDurableObject class
│   │       ├── registry-do.ts      # AgentRegistry Durable Object
│   │       ├── lifecycle.ts        # AgentLifecycle implementation
│   │       ├── state.ts            # StatePersistence implementation
│   │       ├── scheduling.ts       # Scheduling implementation
│   │       ├── transport.ts        # MessageTransport implementation
│   │       ├── resources.ts        # ResourceManagement implementation
│   │       ├── observability.ts    # Observability implementation
│   │       └── index.ts
│   │
│   ├── wire/                       # @loom-loyalty/meridian-wire
│   │   └── src/
│   │       ├── codec.ts            # MessagePack encode/decode
│   │       ├── frame.ts            # Frame header/payload structure
│   │       ├── websocket.ts        # WebSocket transport layer
│   │       └── index.ts
│   │
│   ├── conformance/                # @loom-loyalty/meridian-conformance
│   │   └── src/
│   │       ├── lifecycle.test.ts
│   │       ├── state.test.ts
│   │       ├── scheduling.test.ts
│   │       ├── transport.test.ts
│   │       ├── resources.test.ts
│   │       ├── observability.test.ts
│   │       └── index.ts
│   │
│   └── integration-proxy/          # @loom-loyalty/meridian-proxy
│       └── src/
│           ├── proxy.ts            # Request validation & dispatch
│           ├── session.ts          # Session token management
│           ├── registry.ts         # Service package registration
│           └── index.ts
│
├── examples/
│   ├── hello-agent/                # Minimal agent example
│   ├── feedback-loop/              # Full feedback loop example
│   └── two-agents/                 # Agent-to-agent messaging example
│
├── .github/
│   ├── CONTRIBUTING.md
│   └── workflows/
│       ├── ci.yml
│       └── conformance.yml
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
├── tsconfig.base.json
├── LICENSE                         # Apache 2.0
├── LICENSE-SPECS                   # CC BY 4.0 (specs only)
└── README.md                       # This file
```

## Getting started

```bash
git clone https://github.com/loom-loyalty/meridian.git
cd meridian
pnpm install
pnpm build
pnpm test
```

## Packages

| Package | Description | Status |
|---|---|---|
| `@loom-loyalty/meridian-types` | Shared TypeScript types from the spec | In progress |
| `@loom-loyalty/meridian-wire` | MessagePack/WebSocket wire protocol | In progress |
| `@loom-loyalty/meridian-runtime-cloudflare` | Cloudflare reference adapter (Apache 2.0) | In progress |
| `@loom-loyalty/meridian-conformance` | Runtime conformance test suite | Planned |
| `@loom-loyalty/meridian-proxy` | Credential brokering integration proxy | Planned |

## Related projects

- **[Shuttle](https://github.com/loom-loyalty/shuttle)** — The first product built on Meridian. An opinionated operating system for companies building with agents and humans together.
- **[Harness Engineering](https://github.com/Intense-Visions/harness-engineering)** — Quality enforcement framework. Meridian-compatible integration for mechanical constraints, entropy detection, and agent feedback loops.

## Status

Meridian is in active development. The runtime spec is at v1.0.0-draft.3. The reference adapter is at v0.1. The wire protocol spec is being drafted.

This is pre-1.0 software. APIs will change. We welcome feedback via issues and pull requests.

## License

Code: [Apache 2.0](LICENSE)
Specifications: [CC BY 4.0](LICENSE-SPECS)
