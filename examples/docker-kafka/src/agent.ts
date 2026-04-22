/**
 * KafkaLagMonitor — external Meridian agent running in a Docker
 * sidecar.
 *
 * **Pattern:** this agent lives OUTSIDE any Cloudflare Worker
 * isolate. It talks to a deployed Meridian worker over HTTP
 * (see `./client.ts`) the same way any third-party service would.
 * Two reasons you'd run an agent this way:
 *
 *   1. **Node-native libraries** — `kafkajs` uses raw TCP sockets
 *      + buffer manipulation that workerd doesn't support.
 *   2. **Infrastructure proximity** — the agent runs next to the
 *      Kafka brokers it monitors; no public ingress, no egress
 *      from CF to your VPC.
 *
 * **Lifecycle:**
 *
 *   • On startup: POST /agents/:id/spawn
 *   • Every POLL_INTERVAL_MS: compute consumer lag, emit
 *     InsightFeedback via broadcast to AGENT_DOMAIN
 *   • On SIGTERM/SIGINT: DELETE /agents/:id (graceful wipe)
 *
 * **Receiving agents:** the broadcast lands on any Meridian agent
 * registered in the same domain. If none exist yet, the worker
 * returns `MRD-CF-TR-002` and the monitor logs + continues. This
 * is the documented "emit without a consumer yet" path — adopters
 * wire up a sink agent in their CF worker when they're ready.
 *
 * Runs via `pnpm start` in the Dockerfile; `pnpm dev` for local.
 */

import { Kafka, type Admin } from "kafkajs";
import type { InsightFeedback, Timestamp } from "@loom-loyalty/meridian-types";

import {
  createMeridianClient,
  MeridianHttpError,
  type MeridianClient,
} from "./client.js";

const AGENT_ID = process.env.AGENT_ID ?? "kafka-lag-monitor";
const AGENT_DOMAIN = process.env.AGENT_DOMAIN ?? "infrastructure";
const MERIDIAN_ENDPOINT = required("MERIDIAN_ENDPOINT");
const MERIDIAN_TOKEN = process.env.MERIDIAN_TOKEN;
const KAFKA_BROKERS = required("KAFKA_BROKERS").split(",");
const KAFKA_CLIENT_ID = process.env.KAFKA_CLIENT_ID ?? "meridian-lag-monitor";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const LAG_THRESHOLD = Number(process.env.LAG_THRESHOLD ?? 1_000);

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[kafka-lag-monitor] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

interface ConsumerGroupLag {
  groupId: string;
  totalLag: number;
  topics: Array<{ topic: string; partitionLag: number }>;
}

async function pollConsumerLag(admin: Admin): Promise<ConsumerGroupLag[]> {
  const { groups } = await admin.listGroups();
  const results: ConsumerGroupLag[] = [];

  for (const { groupId } of groups) {
    try {
      const offsets = await admin.fetchOffsets({ groupId });
      // fetchOffsets returns per-topic arrays of partition offsets.
      // To compute lag we also need the END offsets for each topic
      // partition.
      let totalLag = 0;
      const topics: ConsumerGroupLag["topics"] = [];

      for (const { topic, partitions } of offsets) {
        const endOffsets = await admin.fetchTopicOffsets(topic);
        const endByPartition = new Map(
          endOffsets.map((e) => [e.partition, BigInt(e.high ?? "0")]),
        );
        let topicLag = 0;
        for (const { partition, offset } of partitions) {
          const end = endByPartition.get(partition) ?? 0n;
          const current = BigInt(offset ?? "0");
          const lag = Number(end - current);
          if (lag > 0) topicLag += lag;
        }
        totalLag += topicLag;
        topics.push({ topic, partitionLag: topicLag });
      }

      results.push({ groupId, totalLag, topics });
    } catch (err) {
      // Individual group fetches can fail transiently (group
      // rebalancing, short-lived groups). Skip and continue — the
      // next tick will pick it up.
      console.warn(
        `[kafka-lag-monitor] failed to fetch lag for group ${groupId}: ${(err as Error).message}`,
      );
    }
  }

  return results;
}

function buildInsight(lag: ConsumerGroupLag): InsightFeedback {
  const hotspots = lag.topics
    .filter((t) => t.partitionLag > 0)
    .sort((a, b) => b.partitionLag - a.partitionLag)
    .slice(0, 3)
    .map((t) => `${t.topic} (+${t.partitionLag.toLocaleString()})`)
    .join(", ");

  // Confidence scales with absolute lag relative to threshold; caps at
  // 1.0 for anything 10× over. Arbitrary curve — adopters tune.
  const confidence = Math.min(1.0, lag.totalLag / (LAG_THRESHOLD * 10));

  return {
    tier: "expected",
    type: "insight",
    agentId: AGENT_ID,
    domain: AGENT_DOMAIN,
    confidence,
    summary: `Consumer group ${lag.groupId} has ${lag.totalLag.toLocaleString()} messages of lag across ${lag.topics.length} topic(s). Top hotspots: ${hotspots || "(none with lag > 0)"}.`,
    evidence: {
      groupId: lag.groupId,
      totalLag: lag.totalLag,
      topics: lag.topics,
      threshold: LAG_THRESHOLD,
    },
    suggestedAction:
      "Investigate consumer throughput: check per-partition processing time, consumer count vs partition count, and downstream backpressure.",
    timestamp: Date.now() as Timestamp,
  };
}

async function emitInsights(
  client: MeridianClient,
  insights: InsightFeedback[],
): Promise<void> {
  for (const insight of insights) {
    const payload = new TextEncoder().encode(JSON.stringify(insight));
    try {
      const receipt = await client.broadcast(AGENT_ID, AGENT_DOMAIN, payload);
      console.log(
        `[kafka-lag-monitor] emitted insight for group ${insight.evidence && typeof insight.evidence === "object" && "groupId" in insight.evidence ? (insight.evidence as { groupId: string }).groupId : "?"} to ${receipt.recipientCount} recipient(s)`,
      );
    } catch (err) {
      if (err instanceof MeridianHttpError && err.code === "MRD-CF-TR-002") {
        // No peers in the target domain yet. Not fatal — adopters
        // wire up a sink agent in their CF worker when they're
        // ready. Log at info level so this doesn't look like an
        // error during initial deploy.
        console.info(
          `[kafka-lag-monitor] no recipients in domain "${AGENT_DOMAIN}" yet; insight deferred`,
        );
      } else {
        console.error(
          `[kafka-lag-monitor] broadcast failed: ${(err as Error).message}`,
        );
      }
    }
  }
}

export async function runOneTick(
  client: MeridianClient,
  admin: Admin,
): Promise<number> {
  const lags = await pollConsumerLag(admin);
  const concerning = lags.filter((l) => l.totalLag >= LAG_THRESHOLD);
  const insights = concerning.map(buildInsight);
  await emitInsights(client, insights);
  return insights.length;
}

async function main(): Promise<void> {
  const client = createMeridianClient({
    endpoint: MERIDIAN_ENDPOINT,
    token: MERIDIAN_TOKEN,
  });

  const kafka = new Kafka({
    clientId: KAFKA_CLIENT_ID,
    brokers: KAFKA_BROKERS,
  });
  const admin = kafka.admin();
  await admin.connect();
  console.log(
    `[kafka-lag-monitor] connected to brokers: ${KAFKA_BROKERS.join(", ")}`,
  );

  // Spawn (or re-spawn idempotently — same id+domain is a no-op).
  try {
    const handle = await client.spawn(AGENT_ID, AGENT_DOMAIN);
    console.log(
      `[kafka-lag-monitor] spawned ${handle.id} in ${handle.domain} at ${new Date(handle.spawnedAt).toISOString()}`,
    );
  } catch (err) {
    if (err instanceof MeridianHttpError && err.code === "MRD-CF-LC-001") {
      // Different domain mismatch — treat as fatal (operator
      // changed the AGENT_DOMAIN env var without terminating).
      console.error(
        `[kafka-lag-monitor] fatal: agent ${AGENT_ID} exists in a different domain. Terminate it or switch AGENT_DOMAIN back.`,
      );
      process.exit(2);
    }
    throw err;
  }

  // Graceful shutdown on SIGTERM / SIGINT — Docker sends SIGTERM
  // on `docker stop`; local dev uses Ctrl-C (SIGINT).
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[kafka-lag-monitor] ${signal} — shutting down cleanly`);
    try {
      await client.terminate(AGENT_ID);
      console.log(`[kafka-lag-monitor] terminated Meridian agent`);
    } catch (err) {
      console.warn(
        `[kafka-lag-monitor] terminate failed: ${(err as Error).message}`,
      );
    }
    try {
      await admin.disconnect();
    } catch {
      // Best effort; process is exiting.
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Main poll loop.
  while (!shuttingDown) {
    try {
      const emitted = await runOneTick(client, admin);
      console.log(
        `[kafka-lag-monitor] tick complete, emitted=${emitted}, sleeping ${POLL_INTERVAL_MS}ms`,
      );
    } catch (err) {
      console.error(
        `[kafka-lag-monitor] tick failed: ${(err as Error).message}`,
      );
    }
    // Simple sleep rather than setInterval so overruns don't pile up.
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[kafka-lag-monitor] fatal:", err);
    process.exit(1);
  });
}
