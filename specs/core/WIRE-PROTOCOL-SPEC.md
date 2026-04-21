# Meridian Wire Protocol Specification

**Version:** 1.0.0-draft.2
**Status:** Draft
**Date:** April 2026
**License:** CC BY 4.0

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document defines the wire format and transport for Meridian agent-to-agent communication: MessagePack frames over WebSocket, the frame header shape, message-type reservations, and the conversion boundary for LLM injection.

---

## 1. Purpose

This specification defines the wire format and transport for Meridian agent-to-agent communication. All Meridian message exchange uses this format.

---

## 2. Design principles

- **Token efficiency.** JSON is verbose and consumes LLM tokens unnecessarily. The wire format uses binary serialization to reduce payload size.
- **LLM compatibility.** LLMs cannot read raw binary. At model injection boundaries, payloads decode to minified JSON. The wire format optimizes for transport; the model format optimizes for reasoning.
- **Simplicity.** One frame format for all message types. One transport protocol. No negotiation.

---

## 3. Serialization: MessagePack

All Meridian frames are serialized using [MessagePack](https://msgpack.org/). MessagePack is a binary serialization format that:

- Reduces payload size by approximately 17% versus JSON
- Provides 3× serialization/deserialization throughput versus JSON
- Requires no schema definition (unlike Protocol Buffers)
- Is a drop-in replacement for JSON (same data model: maps, arrays, strings, numbers, binary, null)

Implementations should use a well-maintained MessagePack library for their language. The reference implementation uses `msgpackr` (TypeScript).

---

## 4. Transport: WebSocket

Meridian messages are transported over WebSocket connections.

- WebSocket provides persistent, bidirectional, full-duplex communication
- Binary frames (`opcode 0x2`) carry MessagePack-encoded data
- Connections support hibernation (zero cost when idle) on supported runtimes
- Reconnection uses exponential backoff with jitter to prevent thundering herds

Minimum WebSocket version: RFC 6455. Maximum message size: 1 MB (matching the message transport primitive's payload limit from the Runtime Spec).

---

## 5. Frame format

Every message is a single frame containing a header and a payload.

### 5.1 Wire structure

A frame is a MessagePack map with two keys:

```
{
  "h": <FrameHeader>,   // header map
  "p": <Uint8Array>     // payload bytes
}
```

Short keys (`h`, `p`) minimize overhead per frame.

### 5.2 Frame header

The header is a MessagePack map with the following fields:

| Key      | Type    | Required | Description                                                                         |
| -------- | ------- | -------- | ----------------------------------------------------------------------------------- |
| `v`      | integer | yes      | Protocol version. Currently `1`.                                                    |
| `t`      | integer | yes      | Message type (see 5.3).                                                             |
| `id`     | string  | yes      | Unique message ID (UUID v4 recommended).                                            |
| `from`   | string  | yes      | Sender agent ID.                                                                    |
| `to`     | string  | yes      | Recipient agent ID. Empty string for broadcasts. `__system__` for feedback signals. |
| `domain` | string  | yes      | Domain context.                                                                     |
| `cor`    | string  | no       | Correlation ID for request/response patterns.                                       |
| `wi`     | string  | no       | Work item ID for cost attribution.                                                  |
| `ts`     | integer | yes      | Timestamp (ms since Unix epoch).                                                    |
| `ttl`    | integer | no       | Time-to-live in milliseconds. 0 or absent = no expiry.                              |
| `pri`    | integer | no       | Priority: 0 (low), 1 (normal, default), 2 (high).                                   |

### 5.3 Message types

| Value  | Name              | Description                                         |
| ------ | ----------------- | --------------------------------------------------- |
| `0x01` | SEND              | Direct agent-to-agent message                       |
| `0x02` | BROADCAST         | Broadcast to agents matching a selector             |
| `0x03` | REPLY             | Response correlated to a previous message           |
| `0x10` | FEEDBACK          | Feedback signal (heartbeat, error, metric, etc.)    |
| `0x20` | WORK_ITEM         | Work item creation or update                        |
| `0x30` | LIFECYCLE         | Lifecycle event (spawn, suspend, resume, terminate) |
| `0x40` | PRIORITY_QUERY    | Agent query to a domain-local priority engine       |
| `0x41` | PRIORITY_RESPONSE | Response from a priority engine                     |
| `0xFF` | SYSTEM            | Control messages (ping, pong, auth)                 |

Message types `0x04`-`0x0F`, `0x11`-`0x1F`, `0x21`-`0x2F`, `0x31`-`0x3F`, `0x42`-`0x4F`, and `0x50`-`0xFE` are reserved for future use.

### 5.4 Payload

The payload is an opaque `Uint8Array` from the transport's perspective. Its internal format depends on the message type:

- **SEND / REPLY:** Application-defined. Typically a MessagePack-encoded domain object.
- **BROADCAST:** Same as SEND, plus an `AgentSelector` in the header or payload.
- **FEEDBACK:** A serialized `FeedbackSignal` (as defined in the Feedback Contract Spec).
- **WORK_ITEM:** A serialized `WorkItem` (as defined in the Work Item Schema Spec).
- **LIFECYCLE:** A serialized lifecycle event.
- **PRIORITY_QUERY:** A serialized `AgentPriorityQuery` (as defined in `@loom-loyalty/meridian-types`; see [`../patterns/PRIORITY-ENGINE-SPEC.md`](../patterns/PRIORITY-ENGINE-SPEC.md) §4). Addressed to the well-known recipient `"__priority__"` in the sending agent's domain.
- **PRIORITY_RESPONSE:** A serialized `AgentPriorityResponse`. Correlated to the originating `PRIORITY_QUERY` via the frame header's `cor` field.
- **SYSTEM:** Protocol-level control data.

---

## 6. LLM boundary conversion

LLMs cannot process MessagePack binary. At boundaries where message content enters an LLM context:

1. Decode the payload from MessagePack to a JavaScript/Python object
2. Serialize to minified JSON (no whitespace, no pretty-printing)
3. Inject into the model's context

This conversion happens at the agent level, not at the transport level. The transport always uses MessagePack.

```typescript
// At the LLM boundary
import { payloadToJSON } from "@loom-loyalty/meridian-wire";

const jsonForModel = payloadToJSON(frame.payload);
// jsonForModel is a minified JSON string ready for prompt injection
```

---

## 7. Agent discovery

Agents publish their capabilities via Agent Cards at a well-known URL:

```
GET /.well-known/agent-card.json
```

The Agent Card format follows the A2A Agent Card specification with Meridian extensions for domain participation, feedback tier declarations, and runtime requirements.

---

## 8. Security

- WebSocket connections should use `wss://` (TLS) in production.
- Authentication is handled via session tokens or OAuth 2.0 bearer tokens in the WebSocket handshake.
- The wire format does not include encryption. Encryption is a transport-layer concern (TLS).
- Agent identity verification is handled by the runtime's credential layer, not by the wire protocol.

---

_Draft document. Comments welcome via pull request._
