---
"@loom-loyalty/meridian-conformance": minor
---

MCP binding conformance suite, as the new subpath export
`@loom-loyalty/meridian-conformance/mcp`. It runs the minimum scenarios of
`MCP-SPEC.md` §9 plus catalogue, error-envelope, transition, and link checks
from §5 and §7 against any server: adopters adapt their MCP client to the
small `McpAgentClient` interface (`listTools`, `callTool`) and describe the
server as an `McpConformanceTarget`. No MCP SDK or other runtime dependency
is added. Scenarios that need an optional target capability (lease expiry,
a gated transition, a taxonomy proposal, an escalated item, a review count)
are reported as skipped without it.
