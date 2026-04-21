/**
 * Minimal Meridian agent example.
 *
 * This shows the basic structure of a Meridian-compatible agent:
 * - Import types from @loom-loyalty/meridian-types
 * - Use the wire package for MessagePack communication
 * - Emit feedback signals
 * - Handle incoming messages
 */

import type {
  AgentId,
  DomainId,
  HeartbeatFeedback,
  MetricFeedback,
  IncomingMessage,
} from "@loom-loyalty/meridian-types";
import { MeridianTransport, feedbackFrame } from "@loom-loyalty/meridian-wire";

const AGENT_ID: AgentId = "hello-agent-001";
const DOMAIN: DomainId = "engineering";

// ── Heartbeat ────────────────────────────────────────────
// Every Meridian agent must emit heartbeats (required tier)

function emitHeartbeat(transport: MeridianTransport): void {
  const heartbeat: HeartbeatFeedback = {
    tier: "required",
    type: "heartbeat",
    agentId: AGENT_ID,
    domain: DOMAIN,
    status: "running",
    timestamp: Date.now(),
  };

  const frame = feedbackFrame(
    { from: AGENT_ID, domain: DOMAIN },
    heartbeat
  );

  transport.send(frame);
}

// ── Message handler ──────────────────────────────────────
// Respond to incoming messages from other agents

async function handleMessage(msg: IncomingMessage): Promise<void> {
  const payload = new TextDecoder().decode(msg.payload);
  console.log(`[${AGENT_ID}] received from ${msg.fromAgentId}: ${payload}`);

  // Your agent logic goes here.
  // Read state, call tools, emit feedback, send replies.
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const transport = new MeridianTransport({
    url: "ws://localhost:8787/meridian",
    agentId: AGENT_ID,
    onFrame: (frame) => {
      // Route incoming frames to the message handler
      const msg: IncomingMessage = {
        messageId: frame.header.id,
        fromAgentId: frame.header.from,
        toAgentId: frame.header.to,
        payload: frame.payload,
        receivedAt: Date.now(),
        correlationId: frame.header.cor,
        workItemId: frame.header.wi,
      };
      handleMessage(msg);
    },
    onStateChange: (state) => {
      console.log(`[${AGENT_ID}] transport: ${state}`);
    },
  });

  await transport.connect();
  console.log(`[${AGENT_ID}] connected to Meridian runtime`);

  // Emit heartbeat every 30 seconds
  setInterval(() => emitHeartbeat(transport), 30_000);
  emitHeartbeat(transport);
}

main().catch(console.error);
