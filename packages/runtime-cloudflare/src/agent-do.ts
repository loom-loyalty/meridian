/**
 * AgentDurableObject — M1 walking-skeleton scope.
 *
 * One DO instance per spawned agent (id-from-name = agentId). Exposes
 * RPC methods for the five walking-skeleton primitives:
 *   spawn()   — record agent identity + domain in durable storage
 *   save()    — persist a key/value under the agent's namespace
 *   load()    — read a key
 *   sendTo()  — deliver a message to another agent's inbox
 *   receive() — pull received messages from this agent's inbox
 *   terminate() — deleteAll
 *
 * M2 will replace the inbox-append model with a real `onMessage` hook
 * invocation on the user's AgentSpec, plus the full six-primitive
 * implementation (scheduling, resource enforcement, observability).
 */

import { DurableObject } from "cloudflare:workers";
import type {
  AgentId,
  DomainId,
  Timestamp,
} from "@loom-loyalty/meridian-types";

export interface AgentEnv {
  AGENT: DurableObjectNamespace<AgentDurableObject>;
  REGISTRY: DurableObjectNamespace;
}

interface AgentMeta {
  id: AgentId;
  domain: DomainId;
  spawnedAt: Timestamp;
}

export interface InboxEntry {
  fromAgentId: AgentId;
  payload: Uint8Array;
  receivedAt: Timestamp;
}

const META_KEY = "__meta__";
const INBOX_KEY = "__inbox__";
const STATE_PREFIX = "state::";

export class AgentDurableObject extends DurableObject<AgentEnv> {
  async spawn(id: AgentId, domain: DomainId): Promise<void> {
    const existing = await this.ctx.storage.get<AgentMeta>(META_KEY);
    if (existing) {
      // M1: spawn is idempotent for the same (id, domain) tuple. M2 will
      // formalize `idempotent?` on SpawnConfig per RUNTIME-SPEC §4.1.
      if (existing.id !== id || existing.domain !== domain) {
        throw new Error(
          `agent ${existing.id} already spawned in domain ${existing.domain}; cannot re-spawn as ${id}/${domain}`,
        );
      }
      return;
    }
    const meta: AgentMeta = { id, domain, spawnedAt: Date.now() };
    await this.ctx.storage.put(META_KEY, meta);
  }

  async getMeta(): Promise<AgentMeta | undefined> {
    return this.ctx.storage.get<AgentMeta>(META_KEY);
  }

  async save(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(`${STATE_PREFIX}${key}`, value);
  }

  async load<T = unknown>(key: string): Promise<T | undefined> {
    return this.ctx.storage.get<T>(`${STATE_PREFIX}${key}`);
  }

  async sendTo(targetAgentId: AgentId, payload: Uint8Array): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) {
      throw new Error("sendTo called before spawn");
    }
    const targetStub = this.env.AGENT.get(
      this.env.AGENT.idFromName(targetAgentId),
    ) as unknown as DurableObjectStub<AgentDurableObject>;
    await targetStub.deliver(meta.id, payload);
  }

  async deliver(fromAgentId: AgentId, payload: Uint8Array): Promise<void> {
    const inbox = (await this.ctx.storage.get<InboxEntry[]>(INBOX_KEY)) ?? [];
    inbox.push({ fromAgentId, payload, receivedAt: Date.now() });
    await this.ctx.storage.put(INBOX_KEY, inbox);
  }

  async receive(): Promise<InboxEntry[]> {
    return (await this.ctx.storage.get<InboxEntry[]>(INBOX_KEY)) ?? [];
  }

  async terminate(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
