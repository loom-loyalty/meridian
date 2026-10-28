/**
 * MCP binding conformance suite — subpath export.
 *
 * Adapt your MCP client to {@link McpAgentClient}, describe the server
 * under test as an {@link McpConformanceTarget}, and run:
 *
 *     import { runMcpConformance, summarizeMcpConformance } from
 *       "@loom-loyalty/meridian-conformance/mcp";
 *     const results = await runMcpConformance(target);
 *     const { ok } = summarizeMcpConformance(results);
 *
 * No MCP SDK is required; the suite only calls `listTools` and `callTool`.
 * See MCP-SPEC.md §9.
 *
 * @experimental
 */

export * from "./types.js";
export * from "./runner.js";
export { mcpScenarios } from "./scenarios.js";
export {
  MCP_ERROR_CATEGORIES,
  MCP_PROPOSE_TOOLS,
  MCP_READ_TOOLS,
  callError,
  callOk,
  toolError,
} from "./helpers.js";
