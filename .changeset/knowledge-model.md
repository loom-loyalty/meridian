---
"@loom-loyalty/meridian-types": minor
---

Add the experimental knowledge model (`knowledge.ts`, see
`specs/patterns/KNOWLEDGE-SPEC.md`): a tenant-defined, versioned taxonomy
(`TaxonomyDefinition`, `NodeType`, `RelationType`, `NodeTypeMigration`),
the knowledge graph (`KnowledgeNode`, `Relation`), living specs
(`Spec`, `SpecSection`, `SpecRevision`), spec impact (`SpecImpact`,
`SpecImpactEntry`), and gated change proposals (`SpecChangeProposal`,
`TaxonomyChangeProposal`, `ProposalReview`, `ProposalConflict`), plus the
`SpecImpactInferrer` extension point. All new types are `@experimental`.

`WorkItem` gains optional, experimental `parentId`, `typeId` and
`specImpact` fields. The stable `WorkItemType` union is unchanged: the
default ladder's `program` and `project` rungs are taxonomy types that map
to `initiative`, with the tenant type in `typeId`.
