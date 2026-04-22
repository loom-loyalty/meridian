/**
 * @loom-loyalty/meridian-runtime-cloudflare
 *
 * Cloudflare Workers + Durable Objects reference adapter for the Meridian
 * protocol. See `specs/core/RUNTIME-SPEC.md` for the primitive contract
 * and `packages/runtime-cloudflare/README.md` for the adopter guide.
 *
 * M2a scope: full lifecycle + state primitives with internal plugin
 * seams, MRD-* error catalog with stable codes and doc URLs. Transport
 * still uses the M1 inbox-append model (M2c replaces with the
 * sender-partitioned mailbox and user-supplied `onMessage` hook).
 * Scheduling / resources / observability land in M2b / M2d.
 */

export { defineAgent } from "./define-agent.js";
export type { AgentSpec } from "./define-agent.js";

export { AgentDurableObject } from "./agent-do.js";
export type { AgentEnv, InboxEntry } from "./agent-do.js";
export type { FiredSchedule } from "./primitives/cf-scheduling.js";

export { RegistryDurableObject } from "./registry-do.js";
export type { RegistryEnv } from "./registry-do.js";

export { createMeridianWorker } from "./create-meridian-worker.js";
export type { MeridianWorkerConfig } from "./create-meridian-worker.js";

// Error catalog — adopters pattern-match on MRD-* codes from
// RuntimeError.context.code. Code catalog is stable within a major
// version (DX review decision, 2026-04-21).
export { meridianError, isMeridianError, errorCode } from "./errors.js";
export type { MeridianErrorCode } from "./errors.js";
