---
"@loom-loyalty/meridian-types": minor
---

Knowledge model additions found while building Shuttle's knowledge base (all `@experimental`, additive):

- `MoveSectionOperation` (`move_section`) joins `SpecChangeOperation`: move a section after a sibling, first, or last, optionally under a new parent, keeping its id, content, and links. Collaborative drafts can now express reordering.
- `ProposalConflict` gains optional `baseText`, `headText`, and `proposedText`, so a section conflict carries all three sides instead of packing them into `detail`.
- `NodeTypeMigration` gains optional `valueMap` (per field, old value → new value), so a narrowed or renamed enum can be migrated instead of failing the dry run.

`KNOWLEDGE-SPEC.md` §3.3, §8.1, and §9.1 are updated to match.
