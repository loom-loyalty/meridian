/**
 * Frame construction helpers.
 * Convenience functions for building well-formed Meridian wire frames.
 */

import type {
  Frame,
  FrameHeader,
  MessageType,
  AgentId,
  DomainId,
  WorkItemId,
} from "@loom-loyalty/meridian-types";
import { Packr } from "msgpackr";

const payloadPackr = new Packr({ structuredClone: false });

export interface FrameOptions {
  from: AgentId;
  to: AgentId;
  domain: DomainId;
  correlationId?: string;
  workItemId?: WorkItemId;
  ttlMs?: number;
  priority?: 0 | 1 | 2;
}

/** Build a complete frame from options and a payload object. */
export function buildFrame(
  type: MessageType,
  opts: FrameOptions,
  payload: unknown
): Frame {
  const header: FrameHeader = {
    v: 1,
    t: type,
    id: crypto.randomUUID(),
    from: opts.from,
    to: opts.to,
    domain: opts.domain,
    ts: Date.now(),
    ...(opts.correlationId && { cor: opts.correlationId }),
    ...(opts.workItemId && { wi: opts.workItemId }),
    ...(opts.ttlMs && { ttl: opts.ttlMs }),
    ...(opts.priority !== undefined && { pri: opts.priority }),
  };

  const payloadBytes = payloadPackr.pack(payload);

  return { header, payload: payloadBytes };
}

/** Build a direct send frame. */
export function sendFrame(
  opts: FrameOptions,
  payload: unknown
): Frame {
  return buildFrame(0x01, opts, payload); // MessageType.SEND
}

/** Build a feedback frame. */
export function feedbackFrame(
  opts: Omit<FrameOptions, "to">,
  payload: unknown
): Frame {
  return buildFrame(0x10, { ...opts, to: "__system__" }, payload); // MessageType.FEEDBACK
}

/** Build a reply frame correlated to a previous message. */
export function replyFrame(
  originalMessageId: string,
  opts: FrameOptions,
  payload: unknown
): Frame {
  return buildFrame(0x03, { ...opts, correlationId: originalMessageId }, payload); // MessageType.REPLY
}
