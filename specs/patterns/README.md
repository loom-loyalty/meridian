# Meridian Operating Patterns

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

The documents in this directory define Meridian's opinionated operating patterns: how to organize agents and humans into domains, how to express the cost of work and the cost of NOT doing work, how to process the optional-tier feedback signals, and how graduated enforcement surfaces human judgment where it matters.

These patterns are **strongly recommended** for adopters who want Meridian's distinctive value: real-time cost attribution against actual work, domain stewardship over ad-hoc hierarchies, and compound learning from quality signals. Core conformance without patterns gives you transport + primitives; patterns are what differentiate Meridian from a generic MessagePack transport.

| Document                                                     | What it defines                                                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`DOMAIN-SPEC.md`](DOMAIN-SPEC.md)                           | Domain model: stewards, visible budgets, gates, cross-domain work                                                                                                                               |
| [`WORK-ITEM-SPEC.md`](WORK-ITEM-SPEC.md)                     | Work item schema with two cost estimates (cost-to-build + cost-of-not-building) in USD                                                                                                          |
| [`FEEDBACK-PROCESSING-SPEC.md`](FEEDBACK-PROCESSING-SPEC.md) | Optional-tier feedback signals (quality, competing context, pattern recognition) + the five processing mechanisms                                                                               |
| [`PRIORITY-ENGINE-SPEC.md`](PRIORITY-ENGINE-SPEC.md)         | Normative data contracts, escalation mechanism, and query protocol for priority engines. Reference formula in [`@loom-loyalty/meridian-priority-reference`](../../packages/priority-reference/) |

## Where the core/patterns line sits

- **Core** (`../core/`) defines _what data looks like on the wire and in primitives_ — the shape of messages, the shape of runtime calls, the shape of feedback envelopes. Implementations agree on these shapes.
- **Patterns** (here) define _opinionated ways to organize work and process feedback_. Implementations are free to adopt, extend, or replace them. The priority engine is a good example: the spec will define the data contracts and the escalation mechanism (normative), but the formula and weight values are implementation-defined with a shipping reference.
