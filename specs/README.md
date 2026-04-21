# Meridian Specifications

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

## Reading order

Start with [`MERIDIAN-IN-PRACTICE.md`](MERIDIAN-IN-PRACTICE.md) — a narrative walkthrough of a Postgres agent and an Amplitude agent, with real field values from the types package. It shows what Meridian looks like in operation before you dig into the formal specs.

Then:

- [`core/`](core/) — the protocol. Transport, runtime primitives, feedback envelope, skill declaration. Any implementation claiming Meridian conformance implements the stable primitives defined here.
- [`patterns/`](patterns/) — the opinionated operating patterns Loom Loyalty uses. Domain stewardship, two-cost work items, graduated enforcement, feedback processing. Strongly recommended for the distinctive Meridian value, but not required for core conformance.

## Status

All specs in this repository are drafts. APIs will change before v1.0 is finalized. Feedback welcome via issues and pull requests.

## License

Specifications: [CC BY 4.0](../LICENSE-SPECS)
Code: [Apache 2.0](../LICENSE)
