---
"@loom-loyalty/meridian-types": minor
"@loom-loyalty/meridian-conformance": minor
---

Spawned agents act as themselves (MCP binding 1.0.0-draft.3). `Attribution`
and `ExternalAgent` gain an optional `spawnedBy` (`SpawnAttribution`): who
started an agent, recorded as provenance only, so the agent does not act for
its spawner, and the spawner is not excluded from approving its work by that
alone. `meridian_inbox` now serves agents that act for no one with their own
entries, including the new `work_item_transition_requested` kind, instead of
`permission_denied`. The conformance suite adds `spawned-agent-identity`
(MCP-SPEC.md §9 scenario 10), run when the target provides `spawnedAgent()`.
