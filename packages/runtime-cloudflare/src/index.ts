/**
 * @loom-loyalty/meridian-runtime-cloudflare
 *
 * Cloudflare Workers + Durable Objects reference adapter for the
 * Meridian protocol. See `specs/core/RUNTIME-SPEC.md` for the
 * primitive contract and `packages/runtime-cloudflare/README.md` for
 * the adopter guide.
 *
 * M2c scope: full lifecycle + state + scheduling + transport
 * primitives with internal plugin seams. `defineAgent()` ships with
 * progressive-disclosure hooks (onSpawn / onMessage / onTerminate);
 * onSchedule + observability land in M2d. MRD-\* error catalog
 * stable within a major version.
 */

export { defineAgent } from "./define-agent.js";
export type { AgentContext, AgentSpec } from "./define-agent.js";

export { AgentDurableObject } from "./agent-do.js";
export type { AgentEnv } from "./agent-do.js";
export type { FiredSchedule } from "./primitives/cf-scheduling.js";

export { RegistryDurableObject } from "./registry-do.js";
export type { RegistryEnv } from "./registry-do.js";

export { createMeridianWorker } from "./create-meridian-worker.js";
export type { MeridianWorkerConfig } from "./create-meridian-worker.js";

// Error catalog — adopters pattern-match on MRD-\* codes from
// RuntimeError.context.code. Code catalog is stable within a major
// version (DX review decision, 2026-04-21).
export { meridianError, isMeridianError, errorCode } from "./errors.js";
export type { MeridianErrorCode } from "./errors.js";
