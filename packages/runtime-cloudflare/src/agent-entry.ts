/**
 * Lightweight adopter entry for agent modules.
 *
 * The main package entry re-exports `AgentDurableObject` and
 * `RegistryDurableObject`, which transitively import
 * `cloudflare:workers`. That module only resolves inside a Workers
 * runtime — any node-based test harness (including the in-memory
 * `createTestRuntime`) trips on it during module load.
 *
 * This subpath exposes only the symbols an adopter's agent module
 * needs:
 *
 *   • `defineAgent()` — the registry function that wires specs
 *     into the module-level `AGENT_REGISTRY`. No Workers dependency.
 *   • Type aliases for `AgentContext`, `AgentSpec`, `AgentEnv`,
 *     `MeridianErrorCode` — all type-only and erased at runtime.
 *
 * Adopters pattern:
 *
 *   // src/agent.ts — imported by both worker.ts AND node-side tests
 *   import { defineAgent } from "@loom-loyalty/meridian-runtime-cloudflare/agent";
 *
 *   // src/worker.ts — imported only by wrangler deploy
 *   import { createMeridianWorker, AgentDurableObject }
 *     from "@loom-loyalty/meridian-runtime-cloudflare";
 */

export { defineAgent, getAgentSpec, listAgentSpecs } from "./define-agent.js";
export type { AgentContext, AgentSpec } from "./define-agent.js";
export type { AgentEnv } from "./agent-do.js";
export type { FiredSchedule } from "./primitives/cf-scheduling.js";
