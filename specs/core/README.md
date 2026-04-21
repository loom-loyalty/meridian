# Meridian Core Protocol

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

The documents in this directory define the Meridian Core Protocol: transport, runtime primitives, feedback envelope, and skill declaration. These are protocol-shaped — any implementation claiming Meridian conformance implements the stable primitives defined here.

| Document | What it defines |
|---|---|
| [`WIRE-PROTOCOL-SPEC.md`](WIRE-PROTOCOL-SPEC.md) | MessagePack frame format, WebSocket transport, message types, agent discovery |
| [`RUNTIME-SPEC.md`](RUNTIME-SPEC.md) | Six runtime primitives: lifecycle, state, scheduling, messaging, resource limits, observability |
| [`FEEDBACK-SPEC.md`](FEEDBACK-SPEC.md) | The feedback contract: envelope, tier classification, required + expected signal types |
| [`SKILL-SPEC.md`](SKILL-SPEC.md) | Three-stage progressive disclosure for agent capabilities, versioning, marketplace discovery |

Opinionated patterns that build on top of the core protocol (domain stewardship, two-cost work items, graduated enforcement, optional-tier feedback processing) live in [`../patterns/`](../patterns/).
