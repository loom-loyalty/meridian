/**
 * @loom-loyalty/meridian-runtime-cloudflare
 *
 * Cloudflare Workers + Durable Objects reference adapter for the Meridian
 * protocol. See specs/core/RUNTIME-SPEC.md for the primitive contract and
 * packages/runtime-cloudflare/README.md for the adopter guide.
 *
 * M1 scope (walking skeleton): spawn → save → send → receive → terminate
 * on Miniflare. No WebSocket, no admin, no agent-card, no observability.
 * Those land in M2+.
 */

export { defineAgent } from "./define-agent.js";
export type { AgentSpec } from "./define-agent.js";

export { AgentDurableObject } from "./agent-do.js";
export type { AgentEnv, InboxEntry } from "./agent-do.js";

export { RegistryDurableObject } from "./registry-do.js";
export type { RegistryEnv } from "./registry-do.js";

export { createMeridianWorker } from "./create-meridian-worker.js";
export type { MeridianWorkerConfig } from "./create-meridian-worker.js";
