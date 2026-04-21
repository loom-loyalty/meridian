/**
 * Wire protocol types for Meridian agent-to-agent communication.
 * Format: MessagePack-encoded frames over WebSocket.
 */

import type { AgentId, DomainId, WorkItemId, Timestamp } from "./primitives.js";

/** Message types that can be sent over the wire. */
export enum MessageType {
  /** Direct agent-to-agent message */
  SEND = 0x01,
  /** Broadcast to agents matching a selector */
  BROADCAST = 0x02,
  /** Response to a correlated request */
  REPLY = 0x03,
  /** Feedback signal (heartbeat, error, metric, insight, etc.) */
  FEEDBACK = 0x10,
  /** Work item creation or update */
  WORK_ITEM = 0x20,
  /** Lifecycle event (spawn, suspend, resume, terminate) */
  LIFECYCLE = 0x30,
  /**
   * Agent query to a domain-local priority engine.
   * Payload: AgentPriorityQuery. See PRIORITY-ENGINE-SPEC.md §4.
   */
  PRIORITY_QUERY = 0x40,
  /**
   * Response from a domain-local priority engine.
   * Payload: AgentPriorityResponse. See PRIORITY-ENGINE-SPEC.md §4.
   */
  PRIORITY_RESPONSE = 0x41,
  /** System control (ping, pong, auth) */
  SYSTEM = 0xFF,
}

/**
 * Wire frame header. Present on every message.
 * Encoded as a MessagePack map for forward compatibility.
 */
export interface FrameHeader {
  /** Protocol version. Currently 1. */
  v: 1;
  /** Message type discriminator. */
  t: MessageType;
  /** Unique message ID for deduplication. */
  id: string;
  /** Sender agent ID. */
  from: AgentId;
  /** Recipient agent ID (empty string for broadcasts). */
  to: AgentId;
  /** Domain context for this message. */
  domain: DomainId;
  /** Correlation ID for request/response patterns. */
  cor?: string;
  /** Work item ID for cost attribution. */
  wi?: WorkItemId;
  /** Timestamp of creation. */
  ts: Timestamp;
  /** Time-to-live in milliseconds. 0 = no expiry. */
  ttl?: number;
  /** Priority hint. */
  pri?: 0 | 1 | 2; // 0=low, 1=normal, 2=high
}

/**
 * Complete wire frame. Header + payload.
 * The payload is opaque bytes from the runtime's perspective.
 */
export interface Frame {
  header: FrameHeader;
  payload: Uint8Array;
}

/**
 * Agent selector for broadcast messages.
 */
export interface AgentSelector {
  domain?: DomainId;
  metadata?: Record<string, string>;
  capabilities?: string[];
}
