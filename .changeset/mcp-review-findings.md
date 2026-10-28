---
"@loom-loyalty/meridian-types": patch
"@loom-loyalty/meridian-conformance": patch
---

MCP binding 1.0.0-draft.2 (`MCP-SPEC.md`), resolving conformance review
findings. Types: `McpFeedbackSignalInput` makes the server-set `tier`
optional, and a `competing_context` signal's `context.sourceAgentId` too
(new `McpCompetingContextInput`, `McpCompetingContextSignalInput`); doc
comments state that `renewedClaims` is always present for a heartbeat, that
`pendingReviewReasons` covers the escalated items on the page, and that
only an unexpired claim is shown. Conformance: `observer-cannot-create`
requires reason `not_participant`; `claim-after-lease-expiry` requires an
expired claim to be omitted; `heartbeat-extends-lease` requires
`renewedClaims: []` from a heartbeat with nothing to renew (sent without
`tier`); `foreign-agent-id-rejected` also rejects a foreign
`sourceAgentId`; `transition-applied-and-release` requires
`invalid_argument`/`invalid_transition` when leaving `cancelled`.
