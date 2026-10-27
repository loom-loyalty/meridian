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

Additive changes to stable work item types:

- `WorkItemType` gains `"program"` and `"project"` (default ladder is now
  program > project > epic > story > task; `"initiative"` stays valid).
  Code that switches exhaustively over `WorkItemType` (for example with a
  `never` check) will need cases for the two new values.
- `WorkItem` gains optional, experimental `parentId`, `typeId` and
  `specImpact` fields.
