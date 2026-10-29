---
"@loom-loyalty/meridian-types": minor
---

Experimental MCP binding (`MCP-SPEC.md`): the tool contract a runtime serves
over the Model Context Protocol so assistants and externally hosted agents
can work inside a Meridian system. All of it is experimental and additive:

- new module `mcp.ts`: `McpToolName`, `McpPermissionTier` (`read`,
  `propose`), `ExternalAgent`, `McpToolInputs` / `McpToolOutputs` for 19
  `meridian_*` tools, `McpHumanGateHandoff`, `McpToolError`.
- `WorkItemClaim` (claim with lease) and `WorkItemLink` (pull request,
  branch, CI run, session), with optional `WorkItem.claim` and
  `WorkItem.links` (`WORK-ITEM-SPEC.md` §8).

No tool approves, rejects, records a review, or changes gates, budgets,
stewards, or membership.
