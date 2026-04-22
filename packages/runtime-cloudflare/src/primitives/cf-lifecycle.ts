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
import type { RegistryDurableObject } from "../registry-do.js";
import type { LifecyclePlugin } from "./types.js";

/**
 * Minimum env surface the lifecycle plugin needs: access to the
 * REGISTRY namespace so spawn/terminate can keep the registry in sync
 * with live agents. The adapter's real AgentEnv is a superset of this
 * (see `agent-do.ts`); a narrow local interface keeps the plugin
 * compilable without pulling in the full env.
 */
// The lifecycle plugin only needs `idFromName` off the AGENT
// namespace for its identity-guard hash. Typing the field as a
// bare namespace interface (rather than `DurableObjectNamespace<T>`
// parameterized) keeps this contract lenient — any caller whose
// AGENT binding is a DO namespace satisfies it, regardless of
// which DO class the namespace targets.
type AnyDurableObjectNamespace = Pick<
  DurableObjectNamespace,
  "idFromName" | "newUniqueId" | "idFromString" | "get"
>;

export interface LifecycleEnv {
  AGENT: AnyDurableObjectNamespace;
  REGISTRY: DurableObjectNamespace<RegistryDurableObject>;
}

/**
 * Fixed registry shard key for v0.1. M2c tenancy replaces this with
 * `${tenantId}::shard-${hash(agentId) & 15}` per the eng-review
 * decision; keeping a single key here means the shard rollout is
 * purely a key-format change, not a data migration.
 */
const REGISTRY_SHARD_KEY = "default";

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
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: LifecycleEnv,
  ) {}

  private registryStub(): DurableObjectStub<RegistryDurableObject> {
    return this.env.REGISTRY.get(
      this.env.REGISTRY.idFromName(REGISTRY_SHARD_KEY),
    );
  }

  async spawn(config: SpawnConfig): Promise<AgentHandle> {
    if (!config.id || !config.domain) {
      throw meridianError("MRD-CF-LC-004");
    }

    // Guard against sender-identity spoofing. `env.AGENT.idFromName()`
    // is a deterministic hash of the name, so we compute the id the
    // caller WOULD have produced had they addressed this DO via
    // `idFromName(config.id)`, and compare with `this.ctx.id` (the
    // id this DO actually lives under). Any mismatch means the DO
    // was addressed by one name but is being spawned with a different
    // declared identity — adopters could use that to make `sendTo`
    // stamp a forged sender. This check works in real CF and
    // Miniflare because `idFromName(x).toString()` is deterministic
    // regardless of runtime (unlike `ctx.id.name`, which Miniflare
    // does not always populate).
    const expectedId = this.env.AGENT.idFromName(config.id).toString();
    const actualId = this.ctx.id.toString();
    if (expectedId !== actualId) {
      throw meridianError(
        "MRD-CF-LC-005",
        `DO id "${actualId}" does not match idFromName("${config.id}") = "${expectedId}"`,
        { context: { expectedId, actualId, configId: config.id } },
      );
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
    // Keep the registry in sync with live agents. v0.1 uses a single
    // shard; M2c replaces REGISTRY_SHARD_KEY with a tenant-scoped
    // sharded key. Registration failures are logged but don't fail
    // the spawn — the registry is a read-side aid, not a source of
    // truth for lifecycle.
    try {
      await this.registryStub().register(config.id, config.domain);
    } catch (err) {
      console.warn(
        `[registry] failed to register ${config.id}: ${(err as Error).message}`,
      );
    }
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
    // Grab the agent id before wipe so we can unregister. If meta
    // is already absent (double-terminate, never-spawned), skip the
    // unregister — there's nothing to remove.
    const meta = await this.ctx.storage.get<AgentMeta>(META_KEY);

    // `deleteAll()` clears everything in this DO's storage — state,
    // meta, inbox, schedules, AND any existing alarm. We explicitly
    // `deleteAlarm()` afterward as belt-and-suspenders in case the
    // workerd impl ever decouples the two, and write the
    // TERMINATED_KEY sentinel last so subsequent `resume()` can
    // distinguish "this DO was torn down" from "this DO never
    // existed" (both have empty meta, but only the former has the
    // sentinel). DO RPC is serialized by the input gate, so no other
    // method can interleave with this sequence.
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.put(TERMINATED_KEY, true);

    if (meta) {
      try {
        await this.registryStub().unregister(meta.id);
      } catch (err) {
        console.warn(
          `[registry] failed to unregister ${meta.id}: ${(err as Error).message}`,
        );
      }
    }
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
