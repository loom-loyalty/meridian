/**
 * Agent authoring helper — M1 walking-skeleton scope.
 *
 * `defineAgent()` is the single-function authoring API planned for the
 * v0.1 runtime. In M1 (this file) it validates the spec shape and records
 * the spec in a module-level registry. M2 will add the progressive
 * disclosure hooks (onSpawn, onMessage, onSchedule, detectors) plus
 * state typing. The registry is where the runtime looks up spec metadata
 * (domain, initial resource limits) during spawn.
 */

import type { AgentId, DomainId } from "@loom-loyalty/meridian-types";

export interface AgentSpec {
  id: AgentId;
  domain: DomainId;
}

const AGENT_REGISTRY = new Map<AgentId, AgentSpec>();

export function defineAgent(spec: AgentSpec): AgentSpec {
  if (!spec.id) {
    throw new Error("defineAgent: `id` is required");
  }
  if (!spec.domain) {
    throw new Error("defineAgent: `domain` is required");
  }
  AGENT_REGISTRY.set(spec.id, spec);
  return spec;
}

export function getAgentSpec(id: AgentId): AgentSpec | undefined {
  return AGENT_REGISTRY.get(id);
}

export function listAgentSpecs(): AgentSpec[] {
  return Array.from(AGENT_REGISTRY.values());
}
