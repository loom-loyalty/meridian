/**
 * MCP binding conformance contract.
 *
 * The suite is transport-agnostic and carries no MCP SDK: adopters adapt
 * whatever MCP client they use (stdio, Streamable HTTP, an in-process
 * server) to {@link McpAgentClient}, and describe the server under test
 * with {@link McpConformanceTarget}. See MCP-SPEC.md §9.
 *
 * This module only uses `import type` from `@loom-loyalty/meridian-types`,
 * so it can be imported from source (for example with tsx) without a build.
 *
 * @experimental
 */

import type {
  McpPermissionTier,
  WorkItemStatus,
} from "@loom-loyalty/meridian-types";

/**
 * One MCP `tools/call` result as the client returns it. Map the MCP
 * `CallToolResult` onto this shape; `structuredContent` carries the tool
 * output (`McpToolOutputs[name]`) or, with `isError`, `{ error }`.
 *
 * @experimental
 */
export interface McpCallResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: unknown[];
}

/**
 * One entry of an MCP `tools/list` response, narrowed to what the suite
 * checks.
 *
 * @experimental
 */
export interface McpTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/**
 * An authenticated MCP client bound to one external agent.
 *
 * `callTool` MUST resolve with the tool result for tool errors
 * (`isError: true`) and SHOULD reject only for protocol errors (unknown
 * tool, transport failure), as MCP-SPEC.md §7 separates the two.
 *
 * @experimental
 */
export interface McpAgentClient {
  /** The `AgentId` the server minted for this client's token. */
  agentId: string;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/**
 * Options for minting a fresh external agent.
 *
 * @experimental
 */
export interface McpAgentOptions {
  tier: McpPermissionTier;
  /** Role in `domain`. Default `participant`. */
  role?: "participant" | "observer";
  /** Default: the target's `domain`. */
  domain?: string;
  /** The human the agent acts for, if any. */
  actsFor?: string;
}

/**
 * A work item whose next transition is human-gated.
 *
 * @experimental
 */
export interface McpGatedTransitionFixture {
  workItemId: string;
  /** The gated target status. */
  to: WorkItemStatus;
}

/**
 * Taxonomy coordinates for a valid `meridian_propose_taxonomy_change`.
 *
 * @experimental
 */
export interface McpTaxonomyProposalFixture {
  taxonomyId: string;
  baseVersion: number;
  /** `TaxonomyOperation[]` valid against `baseVersion`. */
  operations: unknown[];
}

/**
 * The MCP server under test, as the suite sees it.
 *
 * Every optional member is a capability. A scenario that needs a missing
 * capability is recorded as `skipped`, never silently dropped.
 *
 * @experimental
 */
export interface McpConformanceTarget {
  /** Mint a fresh agent, with its own token, and return a client bound to it. */
  agent(opts: McpAgentOptions): Promise<McpAgentClient>;
  /** A domain where minted agents participate. */
  domain: string;
  /**
   * The domain's root work item type: rung 0 of `domain`'s resolved
   * ladder, as `meridian_get_taxonomy` with `domain` returns it
   * (`resolved.ladder[0]`), creatable without a parent (MCP-SPEC.md §9).
   */
  rootWorkItemTypeId: string;
  /**
   * Make every outstanding lease lapse (advance a clock, or sleep past a
   * short lease). Without it, `claim-after-lease-expiry` is skipped.
   */
  expireLeases?(): Promise<void>;
  /** Short lease (seconds) the server accepts, used with `expireLeases`. */
  shortLeaseSeconds?: number;
  /**
   * Arrange a work item whose transition to `to` is gated under
   * MCP-SPEC.md §5.2 (for example a type with a `human_gate` `GateConfig`
   * moving to `approved`) and which
   * `agent` may attempt (it is a participant and no other agent holds a
   * claim). Without it, `gated-transition-pending` is skipped.
   */
  gatedTransition?(agent: McpAgentClient): Promise<McpGatedTransitionFixture>;
  /**
   * Taxonomy coordinates for a valid taxonomy proposal. Without it,
   * `taxonomy-proposal-handoff` is skipped.
   */
  taxonomyProposal?(): Promise<McpTaxonomyProposalFixture>;
  /**
   * Arrange an escalated work item in `domain` with a pending competing
   * context and return its id. Without it, `escalated-item-unscored` is
   * skipped.
   */
  escalatedWorkItem?(): Promise<string>;
  /**
   * Number of `human_gate` reviews recorded since the suite started, by
   * any means. A runtime-side hook: reviews are not observable through the
   * binding alone (MCP-SPEC.md §9). Checked last; without it,
   * `no-human-gate-review` is skipped.
   */
  humanGateReviewCount?(): Promise<number>;
}

/**
 * Optional target members a scenario may require.
 *
 * @experimental
 */
export type McpConformanceCapability =
  | "expireLeases"
  | "gatedTransition"
  | "taxonomyProposal"
  | "escalatedWorkItem"
  | "humanGateReviewCount";

/**
 * One MCP conformance scenario. `run` throws on failure; it may resolve
 * with a note (for example a SHOULD-level warning) that the runner records
 * as the passed result's `reason`.
 *
 * @experimental
 */
export interface McpConformanceScenario {
  name: string;
  description: string;
  /** Where in MCP-SPEC.md the checked behaviour is defined. */
  specRef: string;
  /** Target capability the scenario needs; skipped without it. */
  requires?: McpConformanceCapability;
  run(target: McpConformanceTarget): Promise<string | void>;
}

/**
 * Outcome of one scenario.
 *
 * @experimental
 */
export interface McpConformanceResult {
  scenario: string;
  status: "passed" | "failed" | "skipped";
  /** Failure message, skip reason, or a passing scenario's warning. */
  reason?: string;
  durationMs: number;
}

/**
 * Options for {@link runMcpConformance}.
 *
 * @experimental
 */
export interface RunMcpConformanceOptions {
  /** Only run scenarios with these names. */
  only?: ReadonlyArray<string>;
  /** Skip scenarios with these names. */
  skip?: ReadonlyArray<string>;
  /** Scenario list. Default {@link mcpScenarios}. */
  scenarios?: ReadonlyArray<McpConformanceScenario>;
}
