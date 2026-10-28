/**
 * Typed call helpers and assertions for the MCP conformance suite.
 *
 * Inputs are typed by `McpToolInputs`, so the suite can only send the
 * shapes MCP-SPEC.md defines. Outputs are cast to `McpToolOutputs` after
 * the envelope checks; scenarios then check the fields they rely on.
 *
 * @experimental
 */

import type {
  ErrorCategory,
  McpErrorReason,
  McpProposeToolName,
  McpReadToolName,
  McpToolError,
  McpToolInputs,
  McpToolName,
  McpToolOutputs,
} from "@loom-loyalty/meridian-types";
import type { McpAgentClient, McpCallResult } from "./types.js";

/** Fails to compile unless `T` is `never`. */
type AssertNever<T extends never> = T;

/**
 * The `read`-tier tools, in MCP-SPEC.md §5 order.
 *
 * @experimental
 */
export const MCP_READ_TOOLS = [
  "meridian_inbox",
  "meridian_list_work_items",
  "meridian_get_work_item",
  "meridian_search",
  "meridian_get_spec",
  "meridian_get_taxonomy",
  "meridian_get_domain",
  "meridian_get_proposal",
] as const satisfies readonly McpReadToolName[];

/**
 * The `propose`-tier tools, in MCP-SPEC.md §5 order.
 *
 * @experimental
 */
export const MCP_PROPOSE_TOOLS = [
  "meridian_create_work_item",
  "meridian_transition_work_item",
  "meridian_claim_work_item",
  "meridian_renew_claim",
  "meridian_release_work_item",
  "meridian_link_artifact",
  "meridian_declare_impacts",
  "meridian_propose_spec_change",
  "meridian_propose_taxonomy_change",
  "meridian_withdraw_proposal",
  "meridian_emit_feedback",
] as const satisfies readonly McpProposeToolName[];

// Compile-time exhaustiveness: the lists above cover every tool name.
type _McpReadToolsExhaustive = AssertNever<
  Exclude<McpReadToolName, (typeof MCP_READ_TOOLS)[number]>
>;
type _McpProposeToolsExhaustive = AssertNever<
  Exclude<McpProposeToolName, (typeof MCP_PROPOSE_TOOLS)[number]>
>;

/**
 * Every `ErrorCategory`, for checking error envelopes at runtime.
 *
 * @experimental
 */
export const MCP_ERROR_CATEGORIES = [
  "not_found",
  "already_exists",
  "permission_denied",
  "unauthenticated",
  "resource_exhausted",
  "invalid_argument",
  "timeout",
  "unavailable",
  "internal",
  "cancelled",
] as const satisfies readonly ErrorCategory[];

type _McpErrorCategoriesExhaustive = AssertNever<
  Exclude<ErrorCategory, (typeof MCP_ERROR_CATEGORIES)[number]>
>;

/**
 * Throw a conformance failure.
 *
 * @experimental
 */
export function fail(message: string): never {
  throw new Error(message);
}

/**
 * Throw unless `condition` holds.
 *
 * @experimental
 */
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

/** Compact JSON for failure messages. */
export function show(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined
    ? String(value)
    : text.length > 400
      ? `${text.slice(0, 400)}…`
      : text;
}

async function rawCall(
  client: McpAgentClient,
  name: McpToolName,
  args: unknown,
): Promise<McpCallResult> {
  try {
    return await client.callTool(name, args as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fail(
      `${name} threw instead of returning a tool result (a protocol error, MCP-SPEC.md §7): ${message}`,
    );
  }
}

/**
 * Call a tool and require success: no `isError`, and `structuredContent`
 * present. Returns the output as `McpToolOutputs[name]`.
 *
 * @experimental
 */
export async function callOk<N extends McpToolName>(
  client: McpAgentClient,
  name: N,
  args: McpToolInputs[N],
): Promise<McpToolOutputs[N]> {
  const result = await rawCall(client, name, args);
  if (result.isError) {
    fail(
      `${name} returned an error, expected success: ${show(result.structuredContent ?? result.content)}`,
    );
  }
  check(
    isRecord(result.structuredContent),
    `${name} returned no structuredContent object`,
  );
  return result.structuredContent as unknown as McpToolOutputs[N];
}

/**
 * Validate a tool error result against MCP-SPEC.md §7 and return its
 * `McpToolError`.
 *
 * @experimental
 */
export function toolError(name: string, result: McpCallResult): McpToolError {
  check(
    result.isError === true,
    `${name}: expected isError: true, got ${show(result.structuredContent)}`,
  );
  const sc = result.structuredContent;
  check(
    isRecord(sc) && isRecord(sc.error),
    `${name}: error result must carry structuredContent { error } (MCP-SPEC.md §7), got ${show(sc)}`,
  );
  const error = sc.error as Record<string, unknown>;
  check(
    typeof error.category === "string" &&
      (MCP_ERROR_CATEGORIES as readonly string[]).includes(error.category),
    `${name}: error.category must be an ErrorCategory, got ${show(error.category)}`,
  );
  check(
    typeof error.message === "string",
    `${name}: error.message must be a string`,
  );
  check(
    typeof error.retryable === "boolean",
    `${name}: error.retryable must be a boolean`,
  );
  check(
    error.reason === undefined || typeof error.reason === "string",
    `${name}: error.reason must be a string when present`,
  );
  return error as unknown as McpToolError;
}

/**
 * Call a tool and require a well-formed tool error with `category` and,
 * when given, `reason`.
 *
 * @experimental
 */
export async function callError<N extends McpToolName>(
  client: McpAgentClient,
  name: N,
  args: McpToolInputs[N],
  expected: { category: ErrorCategory; reason?: McpErrorReason },
): Promise<{ error: McpToolError; result: McpCallResult }> {
  const result = await rawCall(client, name, args);
  if (!result.isError) {
    fail(
      `${name}: expected ${expected.category}${expected.reason ? `/${expected.reason}` : ""}, but the call succeeded: ${show(result.structuredContent)}`,
    );
  }
  const error = toolError(name, result);
  check(
    error.category === expected.category,
    `${name}: expected category ${expected.category}, got ${error.category} (${error.message})`,
  );
  if (expected.reason !== undefined) {
    check(
      error.reason === expected.reason,
      `${name}: expected reason ${expected.reason}, got ${show(error.reason)} (${error.message})`,
    );
  }
  return { error, result };
}

/**
 * True for a non-null, non-array object.
 *
 * @experimental
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
