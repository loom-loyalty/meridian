/**
 * RegistryDurableObject — M1 walking-skeleton scope.
 *
 * M1: single-instance registry tracking which agents have been spawned.
 * M2 will shard by `${tenantId}::shard-${hash(agentId) & 15}` per the
 * eng-review decision; this scaffold keeps the DO class + namespace
 * bindings in place so the shard rollout is additive, not migratory.
 */

import { DurableObject } from "cloudflare:workers";
import type { AgentId, DomainId } from "@loom-loyalty/meridian-types";

export interface RegistryEnv {
  REGISTRY: DurableObjectNamespace;
}

interface RegistryEntry {
  id: AgentId;
  domain: DomainId;
  registeredAt: number;
}

const AGENTS_KEY = "__agents__";

export class RegistryDurableObject extends DurableObject<RegistryEnv> {
  async register(id: AgentId, domain: DomainId): Promise<void> {
    const agents =
      (await this.ctx.storage.get<Record<AgentId, RegistryEntry>>(
        AGENTS_KEY,
      )) ?? {};
    agents[id] = { id, domain, registeredAt: Date.now() };
    await this.ctx.storage.put(AGENTS_KEY, agents);
  }

  async unregister(id: AgentId): Promise<void> {
    const agents =
      (await this.ctx.storage.get<Record<AgentId, RegistryEntry>>(
        AGENTS_KEY,
      )) ?? {};
    delete agents[id];
    await this.ctx.storage.put(AGENTS_KEY, agents);
  }

  async lookup(id: AgentId): Promise<RegistryEntry | undefined> {
    const agents =
      (await this.ctx.storage.get<Record<AgentId, RegistryEntry>>(
        AGENTS_KEY,
      )) ?? {};
    return agents[id];
  }

  async list(): Promise<RegistryEntry[]> {
    const agents =
      (await this.ctx.storage.get<Record<AgentId, RegistryEntry>>(
        AGENTS_KEY,
      )) ?? {};
    return Object.values(agents);
  }
}
