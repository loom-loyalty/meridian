---
"@loom-loyalty/meridian-types": minor
---

Review provenance, risk, and model attribution for knowledge proposals
(`KNOWLEDGE-SPEC.md` §8.2). All of it is experimental and additive:

- optional `basis` (`ReviewBasis`: `written` or `decided`, `standsInFor`,
  `probability`) on `ProposalReview`. A decided review never stands alone
  before an unattended apply.
- optional `risk` (`ProposalRisk`) on `SpecChangeProposal`. It may add a
  human gate (`escalated`), but never removes one or rejects.
- optional `model` (`ModelAttribution`: model, `default`/`pinned`/`routed`,
  router, probability) on `Attribution`.
