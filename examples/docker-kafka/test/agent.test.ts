/**
 * Unit tests for the KafkaLagMonitor agent logic.
 *
 * The full `main()` loop does live Kafka + HTTP I/O and isn't worth
 * stubbing end-to-end. These tests verify the extracted pieces:
 *   • `runOneTick` — the poll → compute → emit path
 *   • `buildInsight` shape (via indirect assertion on the broadcast
 *     payload)
 *   • Error handling: MRD-CF-TR-002 (no recipients yet) is swallowed
 *     gracefully; other MeridianHttpErrors bubble up.
 *
 * Kafka admin is faked via a small handwritten stub. `kafkajs`'s own
 * test doubles pull in the real `kafkajs` module which tries to open
 * TCP sockets on load — the hand stub keeps the test hermetic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Admin } from "kafkajs";

import { MeridianHttpError, type MeridianClient } from "../src/client.js";

// Set required env vars BEFORE importing the agent module — it reads
// them at module load via `required()`.
process.env.MERIDIAN_ENDPOINT = "http://example";
process.env.KAFKA_BROKERS = "localhost:9092";
process.env.LAG_THRESHOLD = "100";

const { runOneTick } = await import("../src/agent.js");

function fakeAdmin(opts: {
  groups: Array<{ groupId: string }>;
  offsetsByGroup: Record<
    string,
    Array<{
      topic: string;
      partitions: Array<{ partition: number; offset: string }>;
    }>
  >;
  endByTopic: Record<string, Array<{ partition: number; high: string }>>;
}): Admin {
  return {
    async listGroups() {
      return { groups: opts.groups };
    },
    async fetchOffsets({ groupId }: { groupId: string }) {
      return opts.offsetsByGroup[groupId] ?? [];
    },
    async fetchTopicOffsets(topic: string) {
      return opts.endByTopic[topic] ?? [];
    },
  } as unknown as Admin;
}

function fakeClient(): MeridianClient & {
  broadcasts: Array<{
    fromId: string;
    domain: string | undefined;
    payload: Uint8Array;
  }>;
} {
  const broadcasts: Array<{
    fromId: string;
    domain: string | undefined;
    payload: Uint8Array;
  }> = [];
  return {
    broadcasts,
    async spawn() {
      return {
        id: "kafka-lag-monitor",
        domain: "infrastructure",
        status: "running",
        spawnedAt: Date.now(),
      } as never;
    },
    async terminate() {},
    async send() {
      return { messageId: "msg-1", queuedAt: Date.now() } as never;
    },
    async broadcast(fromId, domain, payload) {
      broadcasts.push({ fromId, domain, payload });
      return {
        broadcastId: "bc-1",
        recipientCount: 1,
        queuedAt: Date.now(),
      } as never;
    },
    async inbox() {
      return [];
    },
    async drainInbox() {
      return [];
    },
  };
}

describe("runOneTick", () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let consoleInfo: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  it("emits zero insights when no groups have concerning lag", async () => {
    const client = fakeClient();
    const admin = fakeAdmin({
      groups: [{ groupId: "fast-group" }],
      offsetsByGroup: {
        "fast-group": [
          {
            topic: "demo",
            partitions: [{ partition: 0, offset: "100" }],
          },
        ],
      },
      endByTopic: {
        demo: [{ partition: 0, high: "105" }], // lag = 5, below threshold 100
      },
    });

    const emitted = await runOneTick(client, admin);
    expect(emitted).toBe(0);
    expect(client.broadcasts).toHaveLength(0);
  });

  it("emits one insight per group over the lag threshold", async () => {
    const client = fakeClient();
    const admin = fakeAdmin({
      groups: [
        { groupId: "slow-group-a" },
        { groupId: "slow-group-b" },
        { groupId: "fast-group" },
      ],
      offsetsByGroup: {
        "slow-group-a": [
          {
            topic: "events",
            partitions: [
              { partition: 0, offset: "0" },
              { partition: 1, offset: "0" },
            ],
          },
        ],
        "slow-group-b": [
          {
            topic: "events",
            partitions: [{ partition: 0, offset: "500" }],
          },
        ],
        "fast-group": [
          {
            topic: "events",
            partitions: [{ partition: 0, offset: "990" }],
          },
        ],
      },
      endByTopic: {
        events: [
          { partition: 0, high: "1000" },
          { partition: 1, high: "1000" },
        ],
      },
    });

    const emitted = await runOneTick(client, admin);
    // slow-group-a: lag = 2000 (over 100); slow-group-b: lag = 500
    // (over 100); fast-group: lag = 10 (under).
    expect(emitted).toBe(2);
    expect(client.broadcasts).toHaveLength(2);

    // Verify the InsightFeedback shape in the payload.
    const first = JSON.parse(
      new TextDecoder().decode(client.broadcasts[0]!.payload),
    );
    expect(first).toMatchObject({
      tier: "expected",
      type: "insight",
      agentId: "kafka-lag-monitor",
      domain: "infrastructure",
    });
    expect(first.confidence).toBeGreaterThan(0);
    expect(first.evidence.groupId).toMatch(/^slow-group-/);
    expect(first.evidence.totalLag).toBeGreaterThan(100);
  });

  it("swallows MRD-CF-TR-002 (no recipients yet) without throwing", async () => {
    const client = fakeClient();
    // Override broadcast to simulate the "no peers" error.
    client.broadcast = async () => {
      throw new MeridianHttpError(
        "MRD-CF-TR-002",
        "broadcast selector matched 0 registered agents",
        404,
        "not_found",
      );
    };

    const admin = fakeAdmin({
      groups: [{ groupId: "lonely" }],
      offsetsByGroup: {
        lonely: [
          {
            topic: "events",
            partitions: [{ partition: 0, offset: "0" }],
          },
        ],
      },
      endByTopic: {
        events: [{ partition: 0, high: "5000" }],
      },
    });

    // Should not throw — the 002 is an expected "no consumer yet" state.
    const emitted = await runOneTick(client, admin);
    expect(emitted).toBe(1); // insight was built, broadcast attempted, swallowed
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining('no recipients in domain "infrastructure"'),
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("logs a warning when an individual group's offsets fetch fails but keeps going", async () => {
    const client = fakeClient();
    const admin = fakeAdmin({
      groups: [{ groupId: "broken" }, { groupId: "fine" }],
      offsetsByGroup: {
        fine: [
          {
            topic: "events",
            partitions: [{ partition: 0, offset: "0" }],
          },
        ],
      },
      endByTopic: {
        events: [{ partition: 0, high: "5000" }],
      },
    });
    // Make `broken`'s fetch throw.
    const originalFetch = admin.fetchOffsets;
    admin.fetchOffsets = (async (args: { groupId: string }) => {
      if (args.groupId === "broken") throw new Error("rebalance in progress");
      return originalFetch.call(admin, args);
    }) as typeof admin.fetchOffsets;

    const emitted = await runOneTick(client, admin);
    expect(emitted).toBe(1);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("broken"));
  });

  it("propagates non-002 broadcast errors via console.error", async () => {
    const client = fakeClient();
    client.broadcast = async () => {
      throw new MeridianHttpError(
        "MRD-CF-TR-001",
        "payload 1000001 bytes exceeds 1 MB wire limit",
        400,
        "invalid_argument",
      );
    };

    const admin = fakeAdmin({
      groups: [{ groupId: "slow" }],
      offsetsByGroup: {
        slow: [
          {
            topic: "events",
            partitions: [{ partition: 0, offset: "0" }],
          },
        ],
      },
      endByTopic: {
        events: [{ partition: 0, high: "2000" }],
      },
    });

    await runOneTick(client, admin);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("broadcast failed"),
    );
  });
});
