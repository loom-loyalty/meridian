---
"@loom-loyalty/meridian-types": minor
---

Domain-owned taxonomy types and per-domain delivery ladders
(`KNOWLEDGE-SPEC.md` §3, §3.5, §6). All of it is experimental and additive:

- optional `domain` on `NodeType` and `RelationType`. Omitted means a shared
  core type, owned by `TaxonomyDefinition.domain`.
- optional `domainLadders` (`DomainDeliveryLadder`: `domain`, `ladder`) on
  `TaxonomyDefinition`. `deliveryLadder` stays the tenant default.
- optional `domain` on `SetDeliveryLadderOperation`, to set (or, with an
  empty ladder, remove) one domain's ladder.

Taxonomy proposals are now gated by every domain owning a type or ladder they
touch, and always include the human gate for each.
