/**
 * Self-test for the MCP binding conformance suite: runs it against a small
 * in-memory fake server, and against deliberately broken variants to prove
 * scenarios fail when the behaviour they check is missing.
 */

import { describe, expect, it } from "vitest";
import type {
  ErrorCategory,
  McpErrorReason,
  McpPermissionTier,
  McpWorkItemEntry,
  TaxonomyChangeProposal,
  WorkItem,
} from "@loom-loyalty/meridian-types";
import {
  MCP_PROPOSE_TOOLS,
  MCP_READ_TOOLS,
  mcpScenarios,
  runMcpConformance,
  summarizeMcpConformance,
} from "../src/mcp/index.js";
import type {
  McpAgentClient,
  McpCallResult,
  McpConformanceTarget,
} from "../src/mcp/index.js";

interface FakeOptions {
  /** Default true. False lets any agent claim or move a held item. */
  enforceLeases?: boolean;
  /** Default false. True lists propose tools to read tokens. */
  listProposeToReaders?: boolean;
  /** Reason returned for a tier violation. Default `tier_required`. */
  tierReason?: McpErrorReason;
  /** Reason returned for an observer violation. Default `not_participant`. */
  participantReason?: McpErrorReason;
  /** Default false. True leaves an expired claim on `workItem.claim`. */
  showExpiredClaims?: boolean;
  /** Default false. True omits an empty `renewedClaims`. */
  omitEmptyRenewedClaims?: boolean;
  /** Default false. True lets items leave `done` and `cancelled`. */
  allowLeavingTerminal?: boolean;
  /** Default false. True offers spawned agents (`spawnedAgent`). */
  spawned?: boolean;
  /** Default false. True records a spawned agent as acting for its spawner. */
  spawnerActsFor?: boolean;
  /** Default false. True gates moves to `approved` (`gatedTransition`). */
  gates?: boolean;
  /** Default false. True leaves requested transitions out of agent inboxes. */
  omitRequestedEntries?: boolean;
}

interface FakeAgent {
  agentId: string;
  tier: McpPermissionTier;
  role: "participant" | "observer";
  domain: string;
  onBehalfOf?: string;
  spawnedBy?: string;
}

type Args = Record<string, unknown>;

const DOMAIN = "engineering";
const TYPE_ID = "project";
const LEASE_MS = 900_000;

function ok(out: unknown): McpCallResult {
  return {
    structuredContent: out as Record<string, unknown>,
    content: [{ type: "text", text: JSON.stringify(out) }],
  };
}

function err(
  category: ErrorCategory,
  message: string,
  reason?: McpErrorReason,
): McpCallResult {
  return {
    isError: true,
    structuredContent: {
      error: { category, message, retryable: false, reason },
    },
    content: [{ type: "text", text: message }],
  };
}

/** A minimal in-memory MCP server implementing what the suite exercises. */
function createFakeTarget(opts: FakeOptions = {}): McpConformanceTarget {
  const enforceLeases = opts.enforceLeases ?? true;
  let now = 1_700_000_000_000;
  let seq = 0;
  const agents = new Map<string, FakeAgent>();
  const items = new Map<string, WorkItem>();
  const proposals = new Map<string, TaxonomyChangeProposal>();
  /** Gated items, and the pending move each agent requested. */
  const gated = new Set<string>();
  const requested = new Map<string, { agentId: string; to: string }>();
  const readSet = new Set<string>(MCP_READ_TOOLS);

  const tick = () => (now += 1);
  const nextId = (prefix: string) => `${prefix}-${++seq}`;
  const liveClaim = (item: WorkItem) =>
    item.claim && item.claim.leaseExpiresAt > now ? item.claim : undefined;
  /** The item as presented: only an unexpired claim is shown. */
  const view = (item: WorkItem): WorkItem => {
    if (opts.showExpiredClaims || liveClaim(item)) return item;
    const { claim: _expired, ...rest } = item;
    return rest;
  };
  const entry = (item: WorkItem): McpWorkItemEntry => ({
    workItem: view(item),
    priorityScore: item.status === "proposed" ? null : 1,
    explanation: "",
    ...(liveClaim(item) ? { claim: liveClaim(item) } : {}),
  });
  const heldByOther = (item: WorkItem, agentId: string) => {
    const claim = liveClaim(item);
    return enforceLeases && claim !== undefined && claim.agentId !== agentId;
  };

  function call(me: FakeAgent, name: string, args: Args): McpCallResult {
    tick();
    if (!readSet.has(name) && me.tier !== "propose") {
      return err(
        "permission_denied",
        "propose tier required",
        opts.tierReason ?? "tier_required",
      );
    }
    const item =
      typeof args.workItemId === "string"
        ? items.get(args.workItemId)
        : undefined;
    switch (name) {
      case "meridian_create_work_item": {
        const domains = args.domains as string[];
        if (me.role !== "participant" || domains.some((d) => d !== me.domain)) {
          return err(
            "permission_denied",
            "not a participant",
            opts.participantReason ?? "not_participant",
          );
        }
        const created: WorkItem = {
          id: nextId("wi"),
          type: "initiative",
          typeId: args.typeId as string,
          title: args.title as string,
          domains,
          source: "agent",
          sourceAgentId: me.agentId,
          costToBuild: { amountUsd: 0, basis: "unestimated — fake" },
          costOfNotBuilding:
            args.costOfNotBuilding as WorkItem["costOfNotBuilding"],
          confidence: args.confidence as number,
          status: "proposed",
          createdAt: now,
          updatedAt: now,
        };
        items.set(created.id, created);
        return ok({ workItem: created });
      }
      case "meridian_get_work_item": {
        if (!item) return err("not_found", "no such work item");
        return ok({
          item: entry(item),
          ancestors: [],
          childCount: 0,
          childStatusCounts: {},
          relatedSpecs: [],
          proposals: [],
        });
      }
      case "meridian_list_work_items": {
        const all = [...items.values()].filter(
          (i) =>
            i.domains.includes(args.domain as string) &&
            i.status !== "done" &&
            i.status !== "cancelled",
        );
        const start = Number(args.cursor ?? 0);
        const limit = (args.limit as number | undefined) ?? 25;
        const page = all.slice(start, start + limit);
        return ok({
          items: page.map(entry),
          queriedAt: now,
          ...(start + limit < all.length
            ? { nextCursor: String(start + limit) }
            : {}),
        });
      }
      case "meridian_claim_work_item": {
        if (!item) return err("not_found", "no such work item");
        if (item.status === "done" || item.status === "cancelled") {
          return err("invalid_argument", "terminal item");
        }
        if (heldByOther(item, me.agentId)) {
          return err("already_exists", "lease held", "lease_held");
        }
        const ms =
          typeof args.leaseSeconds === "number"
            ? args.leaseSeconds * 1000
            : LEASE_MS;
        item.claim = {
          workItemId: item.id,
          agentId: me.agentId,
          claimedAt: now,
          leaseExpiresAt: now + ms,
          leaseDurationMs: ms,
        };
        return ok({ claim: item.claim });
      }
      case "meridian_transition_work_item": {
        if (!item) return err("not_found", "no such work item");
        if (
          !opts.allowLeavingTerminal &&
          (item.status === "done" || item.status === "cancelled")
        ) {
          return err(
            "invalid_argument",
            "cannot leave a terminal status",
            "invalid_transition",
          );
        }
        if (heldByOther(item, me.agentId)) {
          return err("permission_denied", "lease held", "lease_held");
        }
        if (gated.has(item.id) && args.to === "approved") {
          requested.set(item.id, { agentId: me.agentId, to: "approved" });
          return ok({
            outcome: "pending",
            workItem: view(item),
            pendingTier: "human_gate",
            handoff: handoff(item.id, "approved"),
          });
        }
        item.status = args.to as WorkItem["status"];
        item.updatedAt = now;
        if (item.status === "done" || item.status === "cancelled") {
          delete item.claim;
        }
        return ok({ outcome: "applied", workItem: view(item) });
      }
      case "meridian_inbox": {
        const entries = [];
        if (me.onBehalfOf === undefined && !opts.omitRequestedEntries) {
          for (const [id, r] of requested) {
            if (r.agentId !== me.agentId) continue;
            entries.push({
              kind: "work_item_transition_requested",
              since: now,
              workItem: view(items.get(id)!),
              handoff: handoff(id, r.to),
            });
          }
        }
        return ok({
          principal: {
            agent: {
              kind: "agent",
              id: me.agentId,
              ...(me.onBehalfOf ? { onBehalfOf: me.onBehalfOf } : {}),
              ...(me.spawnedBy
                ? { spawnedBy: { kind: "human", id: me.spawnedBy } }
                : {}),
            },
            tier: me.tier,
            domains: [
              { domain: me.domain, role: me.role, humanIsSteward: false },
            ],
          },
          entries,
        });
      }
      case "meridian_link_artifact": {
        if (!item) return err("not_found", "no such work item");
        const link = args.link as { kind: "pull_request"; url: string };
        item.links = [
          ...(item.links ?? []).filter((l) => l.url !== link.url),
          {
            ...link,
            addedBy: { kind: "agent", id: me.agentId },
            addedAt: now,
          },
        ];
        return ok({ workItem: view(item) });
      }
      case "meridian_emit_feedback": {
        const signal = args.signal as {
          type: string;
          agentId?: string;
          domain: string;
          context?: { sourceAgentId?: string };
        };
        if (signal.agentId !== undefined && signal.agentId !== me.agentId) {
          return err("permission_denied", "foreign agentId");
        }
        const source = signal.context?.sourceAgentId;
        if (source !== undefined && source !== me.agentId) {
          return err("permission_denied", "foreign sourceAgentId");
        }
        if (
          signal.domain !== me.domain ||
          me.role !== "participant" ||
          (args.workItemId !== undefined &&
            !(item?.domains.includes(signal.domain) ?? false))
        ) {
          return err(
            "permission_denied",
            "not a participant",
            "not_participant",
          );
        }
        const renewedClaims = [];
        if (signal.type === "heartbeat") {
          for (const i of items.values()) {
            const claim = liveClaim(i);
            if (!claim || claim.agentId !== me.agentId) continue;
            if (args.workItemId !== undefined && i.id !== args.workItemId)
              continue;
            claim.leaseExpiresAt = now + (claim.leaseDurationMs ?? LEASE_MS);
            claim.renewedAt = now;
            renewedClaims.push(claim);
          }
        }
        const report =
          signal.type === "heartbeat" &&
          (renewedClaims.length > 0 || !opts.omitEmptyRenewedClaims);
        return ok({ receivedAt: now, ...(report ? { renewedClaims } : {}) });
      }
      case "meridian_propose_taxonomy_change": {
        const proposal: TaxonomyChangeProposal = {
          id: nextId("tp"),
          taxonomyId: args.taxonomyId as string,
          baseVersion: args.baseVersion as number,
          operations: args.operations as TaxonomyChangeProposal["operations"],
          rationale: args.rationale as string,
          author: { kind: "agent", id: me.agentId },
          status: args.submit === false ? "draft" : "in_review",
          pendingTier: "human_gate",
          reviews: [],
          createdAt: now,
          updatedAt: now,
        };
        proposals.set(proposal.id, proposal);
        return ok({
          proposal,
          handoff: {
            tier: "human_gate",
            subject: { kind: "proposal", id: proposal.id },
            domains: [DOMAIN],
          },
        });
      }
      case "meridian_withdraw_proposal": {
        const p = proposals.get(args.proposalId as string);
        if (!p) return err("not_found", "no such proposal");
        if (p.author.id !== me.agentId) {
          return err("permission_denied", "not the author", "not_author");
        }
        p.status = "withdrawn";
        return ok({ kind: "taxonomy_change", proposal: p });
      }
      default:
        return err("internal", `${name} not implemented by the fake`);
    }
  }

  function handoff(id: string, to: string) {
    return {
      tier: "human_gate",
      subject: { kind: "work_item", id, to },
      domains: [DOMAIN],
    };
  }

  function clientFor(me: FakeAgent): McpAgentClient {
    const { tier } = me;
    agents.set(me.agentId, me);
    const client: McpAgentClient = {
      agentId: me.agentId,
      async listTools() {
        const names: string[] = [...MCP_READ_TOOLS];
        if (tier === "propose" || opts.listProposeToReaders) {
          names.push(...MCP_PROPOSE_TOOLS);
        }
        return [
          ...names.map((name) => ({
            name,
            annotations: readSet.has(name)
              ? { readOnlyHint: true }
              : {
                  readOnlyHint: false,
                  destructiveHint: name === "meridian_withdraw_proposal",
                },
          })),
          { name: "fake_debug", annotations: { readOnlyHint: true } },
        ];
      },
      async callTool(name, args) {
        // Round-trip through JSON, as a real transport would.
        return JSON.parse(
          JSON.stringify(call(me, name, args)),
        ) as McpCallResult;
      },
    };
    return client;
  }

  return {
    domain: DOMAIN,
    rootWorkItemTypeId: TYPE_ID,
    shortLeaseSeconds: 1,
    async agent({ tier, role, domain, actsFor }) {
      return clientFor({
        agentId: nextId("fake-session"),
        tier,
        role: role ?? "participant",
        domain: domain ?? DOMAIN,
        ...(actsFor ? { onBehalfOf: actsFor } : {}),
      });
    },
    ...(opts.spawned
      ? {
          async spawnedAgent() {
            const spawner = "user_spawner";
            const client = clientFor({
              agentId: nextId("fake-spawned"),
              tier: "propose",
              role: "participant",
              domain: DOMAIN,
              ...(opts.spawnerActsFor
                ? { onBehalfOf: spawner }
                : { spawnedBy: spawner }),
            });
            return { client, spawnedBy: spawner };
          },
        }
      : {}),
    ...(opts.gates
      ? {
          async gatedTransition(agent: McpAgentClient) {
            const out = await agent.callTool("meridian_create_work_item", {
              title: "gated",
              domains: [DOMAIN],
              typeId: TYPE_ID,
              costOfNotBuilding: { amountUsd: 10 },
              confidence: 0.5,
            });
            const id = (out.structuredContent as { workItem: WorkItem })
              .workItem.id;
            gated.add(id);
            return { workItemId: id, to: "approved" as const };
          },
        }
      : {}),
    async expireLeases() {
      now += 2 * LEASE_MS;
    },
    async taxonomyProposal() {
      return {
        taxonomyId: "tax-1",
        baseVersion: 3,
        operations: [
          {
            op: "set_delivery_ladder",
            ladder: ["project", "epic", "story"],
          },
        ],
      };
    },
    async humanGateReviewCount() {
      return 0;
    },
  };
}

function byName(results: Awaited<ReturnType<typeof runMcpConformance>>) {
  return Object.fromEntries(results.map((r) => [r.scenario, r]));
}

describe("MCP conformance suite", () => {
  it("passes against a conformant fake, skipping missing capabilities", async () => {
    const results = await runMcpConformance(createFakeTarget());
    const r = byName(results);
    const failed = results.filter((x) => x.status === "failed");
    expect(failed).toEqual([]);
    expect(results).toHaveLength(mcpScenarios.length);
    expect(r["gated-transition-pending"]!.status).toBe("skipped");
    expect(r["gated-transition-pending"]!.reason).toMatch(/gatedTransition/);
    expect(r["escalated-item-unscored"]!.status).toBe("skipped");
    expect(r["spawned-agent-identity"]!.status).toBe("skipped");
    expect(r["spawned-agent-identity"]!.reason).toMatch(/spawnedAgent/);
    for (const name of [
      "catalogue",
      "read-token-propose-denied",
      "observer-cannot-create",
      "second-claim-lease-held",
      "claim-after-lease-expiry",
      "heartbeat-extends-lease",
      "taxonomy-proposal-handoff",
      "foreign-agent-id-rejected",
      "board-well-typed",
      "error-envelope",
      "transition-applied-and-release",
      "link-artifact",
      "no-human-gate-review",
    ]) {
      expect(r[name]?.status, name).toBe("passed");
    }
    expect(r["catalogue"]!.reason).toBeUndefined();
    expect(summarizeMcpConformance(results)).toMatchObject({
      ok: true,
      failed: 0,
      skipped: 3,
    });
  });

  it("passes spawned-agent-identity and the gated transition with both capabilities", async () => {
    const r = byName(
      await runMcpConformance(
        createFakeTarget({ spawned: true, gates: true }),
        {
          only: ["gated-transition-pending", "spawned-agent-identity"],
        },
      ),
    );
    expect(r["gated-transition-pending"]!.status).toBe("passed");
    expect(r["spawned-agent-identity"]!.status).toBe("passed");
    expect(r["spawned-agent-identity"]!.reason).toBeUndefined();
  });

  it("passes spawned-agent-identity with a note when there is no gated transition", async () => {
    const r = byName(
      await runMcpConformance(createFakeTarget({ spawned: true }), {
        only: ["spawned-agent-identity"],
      }),
    );
    expect(r["spawned-agent-identity"]!.status).toBe("passed");
    expect(r["spawned-agent-identity"]!.reason).toMatch(/not checked/);
  });

  it("fails spawned-agent-identity when a spawned agent acts for its spawner", async () => {
    const r = byName(
      await runMcpConformance(
        createFakeTarget({ spawned: true, spawnerActsFor: true }),
        { only: ["spawned-agent-identity"] },
      ),
    );
    expect(r["spawned-agent-identity"]!.status).toBe("failed");
    expect(r["spawned-agent-identity"]!.reason).toMatch(/onBehalfOf/);
  });

  it("fails spawned-agent-identity when the agent's requested move is missing from its inbox", async () => {
    const r = byName(
      await runMcpConformance(
        createFakeTarget({
          spawned: true,
          gates: true,
          omitRequestedEntries: true,
        }),
        { only: ["spawned-agent-identity"] },
      ),
    );
    expect(r["spawned-agent-identity"]!.status).toBe("failed");
    expect(r["spawned-agent-identity"]!.reason).toMatch(
      /work_item_transition_requested/,
    );
  });

  it("fails second-claim-lease-held when the server does not enforce leases", async () => {
    const r = byName(
      await runMcpConformance(createFakeTarget({ enforceLeases: false })),
    );
    expect(r["second-claim-lease-held"]!.status).toBe("failed");
    expect(r["second-claim-lease-held"]!.reason).toMatch(
      /already_exists\/lease_held/,
    );
  });

  it("fails read-token-propose-denied on the wrong reason", async () => {
    const r = byName(
      await runMcpConformance(
        createFakeTarget({ tierReason: "not_participant" }),
        { only: ["read-token-propose-denied"] },
      ),
    );
    expect(r["read-token-propose-denied"]!.status).toBe("failed");
    expect(r["read-token-propose-denied"]!.reason).toMatch(/tier_required/);
  });

  it("fails observer-cannot-create on the wrong reason", async () => {
    const r = byName(
      await runMcpConformance(
        createFakeTarget({ participantReason: "tier_required" }),
        { only: ["observer-cannot-create"] },
      ),
    );
    expect(r["observer-cannot-create"]!.status).toBe("failed");
    expect(r["observer-cannot-create"]!.reason).toMatch(/not_participant/);
  });

  it("fails claim-after-lease-expiry when an expired claim is still shown", async () => {
    const r = byName(
      await runMcpConformance(createFakeTarget({ showExpiredClaims: true }), {
        only: ["claim-after-lease-expiry"],
      }),
    );
    expect(r["claim-after-lease-expiry"]!.status).toBe("failed");
    expect(r["claim-after-lease-expiry"]!.reason).toMatch(/workItem\.claim/);
  });

  it("fails heartbeat-extends-lease when an empty renewedClaims is omitted", async () => {
    const r = byName(
      await runMcpConformance(
        createFakeTarget({ omitEmptyRenewedClaims: true }),
        { only: ["heartbeat-extends-lease"] },
      ),
    );
    expect(r["heartbeat-extends-lease"]!.status).toBe("failed");
    expect(r["heartbeat-extends-lease"]!.reason).toMatch(/renewedClaims: \[\]/);
  });

  it("fails transition-applied-and-release when items can leave cancelled", async () => {
    const r = byName(
      await runMcpConformance(
        createFakeTarget({ allowLeavingTerminal: true }),
        { only: ["transition-applied-and-release"] },
      ),
    );
    expect(r["transition-applied-and-release"]!.status).toBe("failed");
    expect(r["transition-applied-and-release"]!.reason).toMatch(
      /invalid_argument\/invalid_transition/,
    );
  });

  it("passes catalogue with a warning when read tokens list propose tools", async () => {
    const r = byName(
      await runMcpConformance(
        createFakeTarget({ listProposeToReaders: true }),
        { only: ["catalogue"] },
      ),
    );
    expect(r["catalogue"]!.status).toBe("passed");
    expect(r["catalogue"]!.reason).toMatch(/^warning: read token lists/);
  });

  it("honours only and skip", async () => {
    const results = await runMcpConformance(createFakeTarget(), {
      only: ["error-envelope", "link-artifact"],
      skip: ["link-artifact"],
    });
    expect(results.map((x) => [x.scenario, x.status])).toEqual([
      ["error-envelope", "passed"],
      ["link-artifact", "skipped"],
    ]);
  });

  it("names every scenario uniquely with a description and spec reference", () => {
    const names = mcpScenarios.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of mcpScenarios) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.specRef).toMatch(/§/);
    }
    expect(names.at(-1)).toBe("no-human-gate-review");
  });
});
