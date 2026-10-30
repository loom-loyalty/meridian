/**
 * MCP binding conformance scenarios.
 *
 * The minimum scenarios of MCP-SPEC.md §9, plus catalogue, error-envelope,
 * transition, and link checks from §5 and §7. Every scenario mints its own
 * agents and creates its own work items, so the suite can run against a
 * shared, long-lived server.
 *
 * @experimental
 */

import type {
  McpListWorkItemsOutput,
  McpWorkItemEntry,
  WorkItem,
  WorkItemClaim,
} from "@loom-loyalty/meridian-types";
import {
  MCP_PROPOSE_TOOLS,
  MCP_READ_TOOLS,
  callError,
  callOk,
  check,
  fail,
  isRecord,
  show,
} from "./helpers.js";
import type {
  McpAgentClient,
  McpConformanceScenario,
  McpConformanceTarget,
} from "./types.js";

let counter = 0;

/** A title unique to this process and run, so items can be told apart. */
function uniqueTitle(scenario: string): string {
  counter += 1;
  return `conformance ${scenario} #${counter} ${Date.now()}`;
}

function propose(target: McpConformanceTarget): Promise<McpAgentClient> {
  return target.agent({ tier: "propose" });
}

/**
 * Create a root work item through `meridian_create_work_item` and check
 * the server-set fields of MCP-SPEC.md §5.2.
 */
async function createItem(
  target: McpConformanceTarget,
  agent: McpAgentClient,
  scenario: string,
): Promise<WorkItem> {
  const title = uniqueTitle(scenario);
  const out = await callOk(agent, "meridian_create_work_item", {
    title,
    domains: [target.domain],
    typeId: target.rootWorkItemTypeId,
    costOfNotBuilding: {
      amountUsd: 500,
      basis: "conformance fixture",
    },
    confidence: 0.5,
  });
  const item = out.workItem;
  check(
    isRecord(item),
    `create_work_item: output.workItem missing: ${show(out)}`,
  );
  check(
    typeof item.id === "string" && item.id.length > 0,
    "create_work_item: workItem.id must be a non-empty string",
  );
  check(
    item.status === "proposed",
    `create_work_item: new item must be "proposed", got ${show(item.status)}`,
  );
  check(
    item.source === "agent",
    `create_work_item: source must be "agent", got ${show(item.source)}`,
  );
  check(
    item.sourceAgentId === agent.agentId,
    `create_work_item: sourceAgentId must be the caller ${agent.agentId}, got ${show(item.sourceAgentId)}`,
  );
  check(
    item.typeId === target.rootWorkItemTypeId,
    `create_work_item: typeId must be ${target.rootWorkItemTypeId}, got ${show(item.typeId)}`,
  );
  check(
    Array.isArray(item.domains) && item.domains.includes(target.domain),
    `create_work_item: domains must include ${target.domain}`,
  );
  check(
    isRecord(item.costToBuild) &&
      item.costToBuild.amountUsd === 0 &&
      typeof item.costToBuild.basis === "string" &&
      item.costToBuild.basis.startsWith("unestimated"),
    `create_work_item: without costToBuild the server must set { amountUsd: 0, basis: "unestimated…" }, got ${show(item.costToBuild)}`,
  );
  return item;
}

function checkClaim(
  claim: WorkItemClaim | undefined,
  label: string,
  workItemId: string,
  agentId: string,
): WorkItemClaim {
  check(isRecord(claim), `${label}: output.claim missing`);
  check(
    claim.workItemId === workItemId,
    `${label}: claim.workItemId must be ${workItemId}, got ${show(claim.workItemId)}`,
  );
  check(
    claim.agentId === agentId,
    `${label}: claim.agentId must be ${agentId}, got ${show(claim.agentId)}`,
  );
  check(
    typeof claim.claimedAt === "number",
    `${label}: claim.claimedAt must be a timestamp`,
  );
  check(
    typeof claim.leaseExpiresAt === "number",
    `${label}: claim.leaseExpiresAt must be a timestamp`,
  );
  return claim;
}

/** Page through the board for `domain` until `workItemId` turns up. */
async function findOnBoard(
  agent: McpAgentClient,
  domain: string,
  workItemId: string,
): Promise<{ entry: McpWorkItemEntry; page: McpListWorkItemsOutput }> {
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < 50; pageNo++) {
    const page = await callOk(agent, "meridian_list_work_items", {
      domain,
      limit: 100,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    checkBoardPage(page);
    const entry = page.items.find((e) => e.workItem.id === workItemId);
    if (entry) return { entry, page };
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }
  fail(
    `list_work_items { domain: ${domain} }: item ${workItemId} not found on any page`,
  );
}

/** Check one board page against `McpListWorkItemsOutput`. */
function checkBoardPage(page: McpListWorkItemsOutput): void {
  check(
    Array.isArray(page.items),
    `list_work_items: items must be an array, got ${show(page.items)}`,
  );
  check(
    typeof page.queriedAt === "number",
    `list_work_items: queriedAt must be a timestamp, got ${show(page.queriedAt)}`,
  );
  check(
    page.nextCursor === undefined || typeof page.nextCursor === "string",
    "list_work_items: nextCursor must be a string when present",
  );
  check(
    page.pendingReviewReasons === undefined ||
      Array.isArray(page.pendingReviewReasons),
    "list_work_items: pendingReviewReasons must be an array when present",
  );
  page.items.forEach((entry, i) => {
    const at = `list_work_items: items[${i}]`;
    check(isRecord(entry), `${at} must be an object`);
    const wi = entry.workItem;
    check(isRecord(wi), `${at}.workItem must be an object`);
    check(typeof wi.id === "string", `${at}.workItem.id must be a string`);
    check(
      typeof wi.status === "string",
      `${at}.workItem.status must be a string`,
    );
    check(Array.isArray(wi.domains), `${at}.workItem.domains must be an array`);
    check(
      isRecord(wi.costToBuild) && isRecord(wi.costOfNotBuilding),
      `${at}.workItem must carry costToBuild and costOfNotBuilding`,
    );
    check(
      entry.priorityScore === null || typeof entry.priorityScore === "number",
      `${at}.priorityScore must be a number or null, got ${show(entry.priorityScore)}`,
    );
    check(
      typeof entry.explanation === "string",
      `${at}.explanation must be a string (PrioritizedWorkItem)`,
    );
    check(
      entry.blocked === undefined || Array.isArray(entry.blocked),
      `${at}.blocked must be an array when present`,
    );
    if (
      wi.status === "proposed" ||
      wi.status === "done" ||
      wi.status === "cancelled"
    ) {
      check(
        entry.priorityScore === null,
        `${at}: a ${wi.status} item is not scored, so priorityScore must be null (MCP-SPEC.md §5.1), got ${entry.priorityScore}`,
      );
    }
  });
}

function heartbeat(target: McpConformanceTarget) {
  return {
    tier: "required" as const,
    type: "heartbeat" as const,
    domain: target.domain,
    status: "running" as const,
  };
}

// -----------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------

const catalogue: McpConformanceScenario = {
  name: "catalogue",
  description:
    "tools/list serves all 19 meridian_* tools with the §5 annotations; extra tools avoid the meridian_ prefix; a read token does not list propose tools (SHOULD)",
  specRef: "§4.3, §5",
  async run(target) {
    const agent = await propose(target);
    const tools = await agent.listTools();
    check(Array.isArray(tools), "tools/list must return an array");
    const byName = new Map(tools.map((t) => [t.name, t]));
    const known = new Set<string>([...MCP_READ_TOOLS, ...MCP_PROPOSE_TOOLS]);

    const missing = [...known].filter((n) => !byName.has(n));
    check(
      missing.length === 0,
      `propose token: tools/list is missing ${missing.join(", ")}`,
    );
    const foreign = tools
      .map((t) => t.name)
      .filter((n) => n.startsWith("meridian_") && !known.has(n));
    check(
      foreign.length === 0,
      `the meridian_ prefix is reserved for §5 tools; extra tools use it: ${foreign.join(", ")}`,
    );
    for (const name of MCP_READ_TOOLS) {
      check(
        byName.get(name)?.annotations?.readOnlyHint === true,
        `${name}: read tools MUST set readOnlyHint: true, got ${show(byName.get(name)?.annotations)}`,
      );
    }
    for (const name of MCP_PROPOSE_TOOLS) {
      const ann = byName.get(name)?.annotations;
      check(
        ann?.readOnlyHint === false,
        `${name}: propose tools set readOnlyHint: false, got ${show(ann)}`,
      );
      const destructive = name === "meridian_withdraw_proposal";
      check(
        ann?.destructiveHint === destructive,
        `${name}: expected destructiveHint: ${destructive}, got ${show(ann)}`,
      );
    }

    const reader = await target.agent({ tier: "read" });
    const readerNames = new Set((await reader.listTools()).map((t) => t.name));
    const readMissing = MCP_READ_TOOLS.filter((n) => !readerNames.has(n));
    check(
      readMissing.length === 0,
      `read token: tools/list is missing ${readMissing.join(", ")}`,
    );
    const listed = MCP_PROPOSE_TOOLS.filter((n) => readerNames.has(n));
    if (listed.length > 0) {
      return `warning: read token lists propose tools (SHOULD NOT, §4.3): ${listed.join(", ")}`;
    }
  },
};

const readTokenProposeDenied: McpConformanceScenario = {
  name: "read-token-propose-denied",
  description:
    "§9.1: a read token calling a propose tool, listed or not, gets a tool result (not a JSON-RPC error) with permission_denied, reason tier_required",
  specRef: "§9.1, §4.1, §4.3, §7",
  async run(target) {
    const reader = await target.agent({ tier: "read" });
    await callError(
      reader,
      "meridian_create_work_item",
      {
        title: uniqueTitle("read-token-propose-denied"),
        domains: [target.domain],
        typeId: target.rootWorkItemTypeId,
        costOfNotBuilding: { amountUsd: 1, basis: "conformance fixture" },
        confidence: 0.5,
      },
      { category: "permission_denied", reason: "tier_required" },
    );
  },
};

const observerCannotCreate: McpConformanceScenario = {
  name: "observer-cannot-create",
  description:
    "§9.2: a propose token whose agent is an observer of the domain cannot create a work item there: permission_denied, reason not_participant",
  specRef: "§9.2, §4.3, §7",
  async run(target) {
    const observer = await target.agent({
      tier: "propose",
      role: "observer",
    });
    await callError(
      observer,
      "meridian_create_work_item",
      {
        title: uniqueTitle("observer-cannot-create"),
        domains: [target.domain],
        typeId: target.rootWorkItemTypeId,
        costOfNotBuilding: { amountUsd: 1, basis: "conformance fixture" },
        confidence: 0.5,
      },
      { category: "permission_denied", reason: "not_participant" },
    );
  },
};

const secondClaimLeaseHeld: McpConformanceScenario = {
  name: "second-claim-lease-held",
  description:
    "§9.3: a second agent claiming a held item gets already_exists, reason lease_held; nor may it transition the item",
  specRef: "§9.3, §5.2",
  async run(target) {
    const a = await propose(target);
    const b = await propose(target);
    check(a.agentId !== b.agentId, "two minted agents share an agentId");
    const item = await createItem(target, a, "second-claim-lease-held");
    const claimed = await callOk(a, "meridian_claim_work_item", {
      workItemId: item.id,
    });
    checkClaim(claimed.claim, "claim (A)", item.id, a.agentId);
    await callError(
      b,
      "meridian_claim_work_item",
      { workItemId: item.id },
      { category: "already_exists", reason: "lease_held" },
    );
    await callError(
      b,
      "meridian_transition_work_item",
      {
        workItemId: item.id,
        to: "cancelled",
        note: "conformance: a non-holder must not move a claimed item",
      },
      { category: "permission_denied", reason: "lease_held" },
    );
  },
};

const claimAfterLeaseExpiry: McpConformanceScenario = {
  name: "claim-after-lease-expiry",
  description:
    "§9.3: after the first agent's lease lapses, the item shows no claim and a second agent's claim succeeds",
  specRef: "§9.3, §5.1",
  requires: "expireLeases",
  async run(target) {
    const a = await propose(target);
    const b = await propose(target);
    const item = await createItem(target, a, "claim-after-lease-expiry");
    await callOk(a, "meridian_claim_work_item", {
      workItemId: item.id,
      ...(target.shortLeaseSeconds !== undefined
        ? { leaseSeconds: target.shortLeaseSeconds }
        : {}),
    });
    await target.expireLeases!();
    const lapsed = await callOk(b, "meridian_get_work_item", {
      workItemId: item.id,
    });
    check(
      lapsed.item.claim === undefined,
      `get_work_item: an expired claim must be omitted from item.claim, got ${show(lapsed.item.claim)}`,
    );
    check(
      lapsed.item.workItem.claim === undefined,
      `get_work_item: an expired claim must be omitted from workItem.claim, got ${show(lapsed.item.workItem.claim)}`,
    );
    const out = await callOk(b, "meridian_claim_work_item", {
      workItemId: item.id,
    });
    checkClaim(out.claim, "claim (B after expiry)", item.id, b.agentId);
  },
};

const heartbeatExtendsLease: McpConformanceScenario = {
  name: "heartbeat-extends-lease",
  description:
    "§9.4: a heartbeat from the holder, correlated to the item, renews its claim; a heartbeat with nothing to renew reports renewedClaims: []",
  specRef: "§9.4, §5.3",
  async run(target) {
    const a = await propose(target);
    // The server sets the fixed tier (MCP-SPEC.md §5.3), so omit it here.
    const idle = await callOk(a, "meridian_emit_feedback", {
      signal: { type: "heartbeat", domain: target.domain, status: "running" },
    });
    check(
      Array.isArray(idle.renewedClaims) && idle.renewedClaims.length === 0,
      `emit_feedback: a heartbeat with no claims must report renewedClaims: [] (MCP-SPEC.md §5.3), got ${show(idle)}`,
    );
    const item = await createItem(target, a, "heartbeat-extends-lease");
    const before = checkClaim(
      (await callOk(a, "meridian_claim_work_item", { workItemId: item.id }))
        .claim,
      "claim",
      item.id,
      a.agentId,
    );
    const out = await callOk(a, "meridian_emit_feedback", {
      signal: heartbeat(target),
      workItemId: item.id,
    });
    check(
      typeof out.receivedAt === "number",
      `emit_feedback: receivedAt must be a timestamp, got ${show(out.receivedAt)}`,
    );
    check(
      Array.isArray(out.renewedClaims),
      `emit_feedback: a heartbeat must report renewedClaims, got ${show(out)}`,
    );
    const renewed = out.renewedClaims.find((c) => c.workItemId === item.id);
    check(
      renewed !== undefined,
      `emit_feedback: renewedClaims must include ${item.id}, got ${show(out.renewedClaims)}`,
    );
    checkClaim(renewed, "renewedClaims[]", item.id, a.agentId);
    check(
      renewed.leaseExpiresAt >= before.leaseExpiresAt,
      `emit_feedback: renewed leaseExpiresAt ${renewed.leaseExpiresAt} is earlier than the claim's ${before.leaseExpiresAt}`,
    );
  },
};

const gatedTransitionPending: McpConformanceScenario = {
  name: "gated-transition-pending",
  description:
    "§9.5: a human-gated transition returns pending with a human_gate handoff and leaves the status unchanged",
  specRef: "§9.5, §5.2, §6",
  requires: "gatedTransition",
  async run(target) {
    const a = await propose(target);
    const { workItemId, to } = await target.gatedTransition!(a);
    const before = await callOk(a, "meridian_get_work_item", { workItemId });
    const status = before.item.workItem.status;
    const out = await callOk(a, "meridian_transition_work_item", {
      workItemId,
      to,
      note: "conformance: gated transition",
    });
    check(
      out.outcome === "pending",
      `transition_work_item: expected outcome "pending", got ${show(out.outcome)}`,
    );
    check(
      out.workItem?.status === status,
      `transition_work_item: a pending transition must not change status (${status}), output shows ${show(out.workItem?.status)}`,
    );
    const h = out.handoff;
    check(
      isRecord(h) && h.tier === "human_gate",
      `transition_work_item: expected handoff.tier "human_gate", got ${show(h)}`,
    );
    check(
      h.subject?.kind === "work_item" && h.subject.id === workItemId,
      `transition_work_item: handoff.subject must be { kind: "work_item", id: ${workItemId} }, got ${show(h.subject)}`,
    );
    check(
      Array.isArray(h.domains) && h.domains.length > 0,
      "transition_work_item: handoff.domains must name the deciding domains",
    );
    const after = await callOk(a, "meridian_get_work_item", { workItemId });
    check(
      after.item.workItem.status === status,
      `get_work_item: status changed from ${status} to ${after.item.workItem.status} after a pending transition`,
    );
  },
};

/** Inbox entry kinds addressed to a human, never in an agent's own inbox. */
const HUMAN_INBOX_KINDS = new Set([
  "proposal_awaiting_human_gate",
  "work_item_awaiting_human_gate",
  "budget_alert",
]);

const spawnedAgentIdentity: McpConformanceScenario = {
  name: "spawned-agent-identity",
  description:
    "§9.10: a spawned agent acts as itself: its principal carries spawnedBy and no onBehalfOf, and its inbox is its own",
  specRef: "§9.10, §3.1, §5.1",
  requires: "spawnedAgent",
  async run(target) {
    const { client: a, spawnedBy } = await target.spawnedAgent!();
    const inbox = await callOk(a, "meridian_inbox", {});
    const agent = inbox.principal?.agent;
    check(
      isRecord(agent) && agent.kind === "agent" && agent.id === a.agentId,
      `inbox: principal.agent must be { kind: "agent", id: ${a.agentId} }, got ${show(agent)}`,
    );
    check(
      agent.onBehalfOf === undefined,
      `inbox: a spawned agent acts for no one, but principal.agent.onBehalfOf is ${show(agent.onBehalfOf)}`,
    );
    check(
      agent.spawnedBy?.kind === "human" && agent.spawnedBy.id === spawnedBy,
      `inbox: principal.agent.spawnedBy must be { kind: "human", id: ${spawnedBy} }, got ${show(agent.spawnedBy)}`,
    );
    const human = inbox.entries.filter((e) => HUMAN_INBOX_KINDS.has(e.kind));
    check(
      human.length === 0,
      `inbox: an agent's own inbox lists no human entries, got ${show(human.map((e) => e.kind))}`,
    );
    if (!target.gatedTransition) {
      return "work_item_transition_requested not checked: the target has no gatedTransition";
    }
    const { workItemId, to } = await target.gatedTransition(a);
    const out = await callOk(a, "meridian_transition_work_item", {
      workItemId,
      to,
      note: "conformance: spawned agent's gated transition",
    });
    check(
      out.outcome === "pending",
      `transition_work_item: expected outcome "pending", got ${show(out.outcome)}`,
    );
    const after = await callOk(a, "meridian_inbox", {
      kinds: ["work_item_transition_requested"],
    });
    const mine = after.entries.find(
      (e) =>
        e.kind === "work_item_transition_requested" &&
        e.workItem.id === workItemId,
    );
    check(
      mine !== undefined,
      `inbox: expected a work_item_transition_requested entry for ${workItemId}, got ${show(after.entries.map((e) => e.kind))}`,
    );
    check(
      mine.kind === "work_item_transition_requested" &&
        mine.handoff.tier === "human_gate",
      `inbox: the entry's handoff.tier must be "human_gate", got ${show(mine)}`,
    );
  },
};

const taxonomyProposalHandoff: McpConformanceScenario = {
  name: "taxonomy-proposal-handoff",
  description:
    "§9.6: a submitted taxonomy proposal returns a human_gate handoff, is attributed to the caller, and can be withdrawn by it",
  specRef: "§9.6, §5.2, §3.1",
  requires: "taxonomyProposal",
  async run(target) {
    const a = await propose(target);
    const fx = await target.taxonomyProposal!();
    const out = await callOk(a, "meridian_propose_taxonomy_change", {
      taxonomyId: fx.taxonomyId,
      baseVersion: fx.baseVersion,
      operations: fx.operations as never,
      rationale: "conformance: taxonomy proposal handoff",
    });
    const p = out.proposal;
    check(isRecord(p), `propose_taxonomy_change: proposal missing`);
    check(
      typeof p.id === "string",
      "propose_taxonomy_change: proposal.id must be a string",
    );
    check(
      p.status === "in_review",
      `propose_taxonomy_change: submit defaults to true, so status must be "in_review", got ${show(p.status)}`,
    );
    check(
      p.author?.kind === "agent" && p.author.id === a.agentId,
      `propose_taxonomy_change: author must be { kind: "agent", id: ${a.agentId} }, got ${show(p.author)}`,
    );
    check(
      Array.isArray(p.reviews) &&
        !p.reviews.some((r) => r.tier === "human_gate"),
      `propose_taxonomy_change: no human_gate review may exist on a new proposal, got ${show(p.reviews)}`,
    );
    const h = out.handoff;
    check(
      isRecord(h) && h.tier === "human_gate",
      `propose_taxonomy_change: a submitted taxonomy proposal always returns a human_gate handoff, got ${show(h)}`,
    );
    check(
      h.subject?.kind === "proposal" && h.subject.id === p.id,
      `propose_taxonomy_change: handoff.subject must be { kind: "proposal", id: ${p.id} }, got ${show(h.subject)}`,
    );
    const withdrawn = await callOk(a, "meridian_withdraw_proposal", {
      proposalId: p.id,
      reason: "conformance cleanup",
    });
    check(
      withdrawn.kind === "taxonomy_change" &&
        withdrawn.proposal?.status === "withdrawn",
      `withdraw_proposal: expected a taxonomy_change view in "withdrawn", got ${show({ kind: withdrawn.kind, status: withdrawn.proposal?.status })}`,
    );
  },
};

const foreignAgentIdRejected: McpConformanceScenario = {
  name: "foreign-agent-id-rejected",
  description:
    "§9.7: a signal carrying another agent's agentId, or a competing context with another agent's sourceAgentId, is rejected with permission_denied",
  specRef: "§9.7, §5.3",
  async run(target) {
    const a = await propose(target);
    const other = await propose(target);
    check(a.agentId !== other.agentId, "two minted agents share an agentId");
    await callError(
      a,
      "meridian_emit_feedback",
      { signal: { ...heartbeat(target), agentId: other.agentId } },
      { category: "permission_denied" },
    );
    const item = await createItem(target, a, "foreign-agent-id-rejected");
    await callError(
      a,
      "meridian_emit_feedback",
      {
        signal: {
          type: "competing_context",
          domain: target.domain,
          context: {
            sourceAgentId: other.agentId,
            contestedWorkItemId: item.id,
            concern: "cost_risk",
            impact: { blastRadius: "isolated" },
            argument: "conformance: foreign sourceAgentId",
            confidence: 0.5,
          },
        },
        workItemId: item.id,
      },
      { category: "permission_denied" },
    );
  },
};

const boardWellTyped: McpConformanceScenario = {
  name: "board-well-typed",
  description:
    "§9.8: meridian_list_work_items returns well-typed entries, including proposed items with priorityScore null",
  specRef: "§9.8, §5.1",
  async run(target) {
    const a = await propose(target);
    const item = await createItem(target, a, "board-well-typed");
    const { entry } = await findOnBoard(a, target.domain, item.id);
    check(
      entry.priorityScore === null,
      `list_work_items: a proposed item must have priorityScore null, got ${entry.priorityScore}`,
    );
  },
};

const escalatedItemUnscored: McpConformanceScenario = {
  name: "escalated-item-unscored",
  description:
    "§9.8: an escalated item is listed with priorityScore null and pendingReviewReasons naming it, and cannot be claimed",
  specRef: "§9.8, §5.1, §5.2",
  requires: "escalatedWorkItem",
  async run(target) {
    const a = await propose(target);
    const id = await target.escalatedWorkItem!();
    const { entry, page } = await findOnBoard(a, target.domain, id);
    check(
      entry.priorityScore === null,
      `list_work_items: an escalated item must have priorityScore null, got ${entry.priorityScore}`,
    );
    const reasons = page.pendingReviewReasons ?? [];
    check(
      reasons.some((r) => r.contestedWorkItemId === id),
      `list_work_items: pendingReviewReasons must include a competing context for ${id}, got ${show(reasons)}`,
    );
    await callError(
      a,
      "meridian_claim_work_item",
      { workItemId: id },
      { category: "permission_denied", reason: "escalated" },
    );
  },
};

const errorEnvelope: McpConformanceScenario = {
  name: "error-envelope",
  description:
    "§7: a call naming an unknown work item returns isError with { error: { category: not_found, message, retryable } }",
  specRef: "§7",
  async run(target) {
    const a = await propose(target);
    const { result } = await callError(
      a,
      "meridian_claim_work_item",
      { workItemId: `conformance-missing-${Date.now()}` },
      { category: "not_found" },
    );
    const hasText =
      Array.isArray(result.content) &&
      result.content.some((c) => isRecord(c) && c.type === "text");
    if (!hasText) {
      return "warning: error result carries no text content block for clients that ignore structured content (§7)";
    }
  },
};

const transitionAppliedAndRelease: McpConformanceScenario = {
  name: "transition-applied-and-release",
  description:
    "§5.2: ungated transitions (proposed → researching → cancelled) are applied; an applied transition to cancelled releases the claim; leaving cancelled is invalid_argument/invalid_transition",
  specRef: "§5.2",
  async run(target) {
    const a = await propose(target);
    const item = await createItem(target, a, "transition-applied-and-release");
    await callOk(a, "meridian_claim_work_item", { workItemId: item.id });
    const first = await callOk(a, "meridian_transition_work_item", {
      workItemId: item.id,
      to: "researching",
      note: "conformance: start research",
    });
    check(
      first.outcome === "applied",
      `transition proposed → researching: expected "applied", got ${show(first.outcome)}`,
    );
    check(
      first.workItem?.status === "researching",
      `transition: workItem.status must be the new status, got ${show(first.workItem?.status)}`,
    );
    const second = await callOk(a, "meridian_transition_work_item", {
      workItemId: item.id,
      to: "cancelled",
      note: "conformance: cancel",
    });
    check(
      second.outcome === "applied",
      `transition researching → cancelled: expected "applied", got ${show(second.outcome)}`,
    );
    const ctx = await callOk(a, "meridian_get_work_item", {
      workItemId: item.id,
    });
    check(
      ctx.item.workItem.status === "cancelled",
      `get_work_item: expected status cancelled, got ${ctx.item.workItem.status}`,
    );
    check(
      ctx.item.claim === undefined && ctx.item.workItem.claim === undefined,
      `get_work_item: an applied transition to cancelled releases the claim, but item.claim is ${show(ctx.item.claim)} and workItem.claim is ${show(ctx.item.workItem.claim)}`,
    );
    await callError(
      a,
      "meridian_transition_work_item",
      {
        workItemId: item.id,
        to: "researching",
        note: "conformance: leaving a terminal status",
      },
      { category: "invalid_argument", reason: "invalid_transition" },
    );
  },
};

const linkArtifact: McpConformanceScenario = {
  name: "link-artifact",
  description:
    "§5.2: a linked artifact is appended with server-set addedBy/addedAt; a link with the same url replaces it",
  specRef: "§5.2",
  async run(target) {
    const a = await propose(target);
    const item = await createItem(target, a, "link-artifact");
    const url = `https://example.com/pr/${Date.now()}`;
    const first = await callOk(a, "meridian_link_artifact", {
      workItemId: item.id,
      link: { kind: "pull_request", url, title: "Conformance PR" },
    });
    const links = first.workItem?.links;
    check(
      Array.isArray(links),
      `link_artifact: workItem.links must be an array, got ${show(links)}`,
    );
    const link = links.find((l) => l.url === url);
    check(link !== undefined, `link_artifact: links must contain ${url}`);
    check(
      link.kind === "pull_request",
      `link_artifact: kind must be pull_request, got ${show(link.kind)}`,
    );
    check(
      link.addedBy?.kind === "agent" && link.addedBy.id === a.agentId,
      `link_artifact: addedBy must be { kind: "agent", id: ${a.agentId} }, got ${show(link.addedBy)}`,
    );
    check(
      typeof link.addedAt === "number",
      "link_artifact: addedAt must be a timestamp set by the server",
    );
    const second = await callOk(a, "meridian_link_artifact", {
      workItemId: item.id,
      link: { kind: "pull_request", url, title: "Conformance PR (renamed)" },
    });
    const same = (second.workItem?.links ?? []).filter((l) => l.url === url);
    check(
      same.length === 1 && same[0]!.title === "Conformance PR (renamed)",
      `link_artifact: a link with the same url replaces the earlier one, got ${show(same)}`,
    );
  },
};

const noHumanGateReview: McpConformanceScenario = {
  name: "no-human-gate-review",
  description:
    "§9.9: after every other scenario has run, no human_gate review has been recorded",
  specRef: "§9.9, §6",
  requires: "humanGateReviewCount",
  async run(target) {
    const count = await target.humanGateReviewCount!();
    check(
      count === 0,
      `expected no human_gate reviews after the suite, found ${count}`,
    );
  },
};

/**
 * The MCP binding conformance scenarios, in run order.
 * `no-human-gate-review` is last so it observes every earlier call.
 *
 * @experimental
 */
export const mcpScenarios: ReadonlyArray<McpConformanceScenario> = [
  catalogue,
  readTokenProposeDenied,
  observerCannotCreate,
  secondClaimLeaseHeld,
  claimAfterLeaseExpiry,
  heartbeatExtendsLease,
  gatedTransitionPending,
  spawnedAgentIdentity,
  taxonomyProposalHandoff,
  foreignAgentIdRejected,
  boardWellTyped,
  escalatedItemUnscored,
  errorEnvelope,
  transitionAppliedAndRelease,
  linkArtifact,
  noHumanGateReview,
];
