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
}

interface FakeAgent {
  agentId: string;
  tier: McpPermissionTier;
  role: "participant" | "observer";
  domain: string;
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
  const readSet = new Set<string>(MCP_READ_TOOLS);

  const tick = () => (now += 1);
  const nextId = (prefix: string) => `${prefix}-${++seq}`;
  const liveClaim = (item: WorkItem) =>
    item.claim && item.claim.leaseExpiresAt > now ? item.claim : undefined;
  const entry = (item: WorkItem): McpWorkItemEntry => ({
    workItem: item,
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
            "not_participant",
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
        if (heldByOther(item, me.agentId)) {
          return err("permission_denied", "lease held", "lease_held");
        }
        item.status = args.to as WorkItem["status"];
        item.updatedAt = now;
        if (item.status === "done" || item.status === "cancelled") {
          delete item.claim;
        }
        return ok({ outcome: "applied", workItem: item });
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
        return ok({ workItem: item });
      }
      case "meridian_emit_feedback": {
        const signal = args.signal as {
          type: string;
          agentId?: string;
          domain: string;
        };
        if (signal.agentId !== undefined && signal.agentId !== me.agentId) {
          return err("permission_denied", "foreign agentId");
        }
        if (signal.domain !== me.domain || me.role !== "participant") {
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
        return ok({
          receivedAt: now,
          ...(renewedClaims.length > 0 ? { renewedClaims } : {}),
        });
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

  return {
    domain: DOMAIN,
    rootWorkItemTypeId: TYPE_ID,
    shortLeaseSeconds: 1,
    async agent({ tier, role, domain }) {
      const me: FakeAgent = {
        agentId: nextId("fake-session"),
        tier,
        role: role ?? "participant",
        domain: domain ?? DOMAIN,
      };
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
    },
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
      skipped: 2,
    });
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
