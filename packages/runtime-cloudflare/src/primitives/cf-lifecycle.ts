/**
 * Cloudflare implementation of the {@link LifecyclePlugin} seam.
 *
 * Maps the six stable lifecycle operations onto Durable Object storage.
 * One DO instance = one agent (`env.AGENT.idFromName(agentId)`), so the
 * plugin is effectively scoped to this DO — the `agentId` param from
 * the public `AgentLifecycle` interface collapses into the DO binding.
 *
 * Status transitions tracked in `__meta__`:
 *
 *     spawn  → running
 *     suspend ⇆ resume
 *     terminate → (delete all, meta gone)
 *
 * `snapshotState` throws `MRD-CF-EX-001` per the @experimental contract.
 */

import type {
  AgentHandle,
  AgentId,
  DomainId,
  SpawnConfig,
  Timestamp,
} from "@loom-loyalty/meridian-types";

import { meridianError } from "../errors.js";
import type { LifecyclePlugin } from "./types.js";

interface AgentMeta {
  id: AgentId;
  domain: DomainId;
  status: AgentHandle["status"];
  spawnedAt: Timestamp;
  metadata?: Record<string, string>;
}

const META_KEY = "__meta__";

/**
 * Internal sentinel. `AgentDurableObject` records termination so
 * `resume()` can distinguish "never existed" from "used to exist, now
 * wiped" and raise a more actionable error. The terminated flag is
 * cleared if the DO is re-spawned later.
 */
const TERMINATED_KEY = "__terminated__";

export class CfLifecyclePlugin implements LifecyclePlugin {
  constructor(private readonly ctx: DurableObjectState) {}

  async spawn(config: SpawnConfig): Promise<AgentHandle> {
    if (!config.id || !config.domain) {
      throw meridianError("MRD-CF-LC-004");
    }

    if (config.fromSnapshot !== undefined) {
      throw meridianError("MRD-CF-EX-002", undefined, {
        context: { fromSnapshot: config.fromSnapshot },
      });
    }

    if (config.permissions !== undefined) {
      // v0.1: PermissionScope is @experimental. Per the plan's
      // compliance row (RUNTIME-SPEC §4.1), we drop it with a warning
      // rather than rejecting the spawn. AuthPlugin in v0.1.5 will
      // honor it.
      console.warn(
        `[MRD-CF-EX-003] ${config.id}: SpawnConfig.permissions dropped; AuthPlugin lands in v0.1.5`,
      );
    }

    const existing = await this.ctx.storage.get<AgentMeta>(META_KEY);

    // Spawn is idempotent for the same (id, domain) tuple per the
    // idempotent? hint in SpawnConfig; identity changes are rejected
    // regardless of the hint because a DO name is 1:1 with agentId.
    if (existing) {
      if (existing.id !== config.id || existing.domain !== config.domain) {
        throw meridianError(
          "MRD-CF-LC-001",
          `existing agent ${existing.id}/${existing.domain} on this DO; cannot re-spawn as ${config.id}/${config.domain}`,
          {
            context: {
              existing,
              requested: { id: config.id, domain: config.domain },
            },
          },
        );
      }
      return this.handleFrom(existing);
    }

    const meta: AgentMeta = {
      id: config.id,
      domain: config.domain,
      status: "running",
      spawnedAt: Date.now(),
      metadata: config.metadata,
    };
    await this.ctx.storage.put(META_KEY, meta);
    await this.ctx.storage.delete(TERMINATED_KEY);
    return this.handleFrom(meta);
  }

  async suspend(): Promise<void> {
    const meta = await this.requireMeta();
    if (meta.status === "suspended") return;
    await this.ctx.storage.put(META_KEY, { ...meta, status: "suspended" });
  }

  async resume(): Promise<void> {
    const terminated = await this.ctx.storage.get<boolean>(TERMINATED_KEY);
    if (terminated) {
      throw meridianError("MRD-CF-LC-003");
    }
    const meta = await this.requireMeta();
    if (meta.status === "running") return;
    await this.ctx.storage.put(META_KEY, { ...meta, status: "running" });
  }

  async terminate(): Promise<void> {
    // Record termination BEFORE wiping so a concurrent resume() sees
    // the flag instead of silently re-creating state under a cleared
    // meta entry. deleteAll clears META_KEY + TERMINATED_KEY alongside
    // everything else, so we re-mark after the wipe.
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.put(TERMINATED_KEY, true);
  }

  async get(): Promise<AgentHandle> {
    const meta = await this.requireMeta();
    return this.handleFrom(meta);
  }

  async exists(): Promise<boolean> {
    const meta = await this.ctx.storage.get<AgentMeta>(META_KEY);
    return meta !== undefined;
  }

  async snapshotState(): Promise<never> {
    throw meridianError("MRD-CF-EX-001");
  }

  /** Internal: read meta, throwing the canonical not-spawned error. */
  async requireMeta(): Promise<AgentMeta> {
    const meta = await this.ctx.storage.get<AgentMeta>(META_KEY);
    if (!meta) throw meridianError("MRD-CF-LC-002");
    return meta;
  }

  /** Internal: project AgentMeta → public AgentHandle. */
  private handleFrom(meta: AgentMeta): AgentHandle {
    return {
      id: meta.id,
      domain: meta.domain,
      status: meta.status,
      spawnedAt: meta.spawnedAt,
    };
  }
}
