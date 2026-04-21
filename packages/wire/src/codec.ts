/**
 * MessagePack codec for Meridian wire frames.
 *
 * Encodes Frame objects to binary Uint8Array for WebSocket transport.
 * Decodes binary Uint8Array back to Frame objects.
 *
 * Uses msgpackr for high-performance serialization.
 * At LLM injection boundaries, use toJSON() to convert to minified JSON.
 */

import { Packr, Unpackr } from "msgpackr";
import type { Frame, FrameHeader } from "@loom-loyalty/meridian-types";

const packr = new Packr({
  structuredClone: false,
  mapsAsObjects: true,
});

const unpackr = new Unpackr({
  mapsAsObjects: true,
});

/** Encode a Frame to binary MessagePack bytes. */
export function encode(frame: Frame): Uint8Array {
  return packr.pack({
    h: frame.header,
    p: frame.payload,
  });
}

/** Decode binary MessagePack bytes to a Frame. */
export function decode(data: Uint8Array): Frame {
  const unpacked = unpackr.unpack(data) as { h: FrameHeader; p: Uint8Array };
  return {
    header: unpacked.h,
    payload: unpacked.p instanceof Uint8Array
      ? unpacked.p
      : new Uint8Array(unpacked.p),
  };
}

/**
 * Convert a Frame's payload to minified JSON string.
 * Used at LLM injection boundaries where models need text, not binary.
 */
export function payloadToJSON(payload: Uint8Array): string {
  const decoded = unpackr.unpack(payload);
  return JSON.stringify(decoded);
}

/**
 * Convert a JSON string to a MessagePack payload.
 * Used when an LLM produces output that needs to enter the wire protocol.
 */
export function jsonToPayload(json: string): Uint8Array {
  const parsed = JSON.parse(json);
  return packr.pack(parsed);
}

/**
 * Estimate the token savings of this frame versus JSON encoding.
 * Useful for cost attribution and protocol efficiency monitoring.
 */
export function estimateTokenSavings(frame: Frame): {
  msgpackBytes: number;
  jsonBytes: number;
  savingsPercent: number;
} {
  const msgpackBytes = encode(frame).byteLength;
  const jsonBytes = new TextEncoder().encode(
    JSON.stringify({ h: frame.header, p: Array.from(frame.payload) })
  ).byteLength;
  return {
    msgpackBytes,
    jsonBytes,
    savingsPercent: Math.round((1 - msgpackBytes / jsonBytes) * 100),
  };
}
