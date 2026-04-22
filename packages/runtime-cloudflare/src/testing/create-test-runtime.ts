/**
 * In-memory test runtime for adopter unit tests.
 *
 * Implements the `Runtime` contract from `@loom-loyalty/meridian-conformance/runtime`
 * entirely in-process — no Miniflare, no Durable Objects, no
 * `wrangler dev` boot. Adopter unit tests can exercise agent hooks
 * and business logic with millisecond setup cost.
 *
 * Parity is enforced by running the same conformance suite against
 * both this runtime and the Miniflare-backed one inside CI. If the
 * two diverge, the build fails — so adopters can trust that passing
 * locally means passing on CF.
 *
 * What this does NOT cover: durability across process restarts,
 * hibernation-replay, true DO alarm coalescing across offline
 * windows. Those scenarios declare `appliesTo: ["real-cf"]` and
 * skip here cleanly; the E2E workflow runs them against the real
 * CF test account.
 */

import type {
  AgentFixture,
  AgentRef,
  Runtime,
} from "@loom-loyalty/meridian-conformance/runtime";
import type {
  AgentHandle,
  AgentId,
  AgentSelector,
  BroadcastReceipt,
  IncomingMessage,
  ListOptions,
  ListResult,
  MessageReceipt,
  ResourceLimits,
  ResourceUsage,
  ResourceWarning,
  ScheduleId,
  ScheduleInfo,
  SpawnConfig,
  Timestamp,
} from "@loom-loyalty/meridian-types";
import { Cron } from "croner";

import { meridianError } from "../errors.js";

interface AgentState {
  handle: AgentHandle;
  storage: Map<string, unknown>;
  schedules: Map<
    ScheduleId,
    {
      id: ScheduleId;
      type: "once" | "cron";
      cron?: string;
      payload?: unknown;
      nextFireAt: Timestamp;
    }
  >;
  inbox: IncomingMessage[];
  nextSeqBySender: Map<AgentId, number>;
  limits: ResourceLimits;
  usage: {
    memoryMB: number;
    cpuMsLifetime: number;
    tokensLifetime: number;
    costUsdLifetime: number;
    activeOperations: number;
  };
  warnings: ResourceWarning[];
  wiTokens: Map<string, number>;
  wiCost: Map<string, number>;
  terminated: boolean;
}

const MIN_DELAY_MS = 1_000;
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1_000;
const PAYLOAD_MAX_BYTES = 1_000_000;
const STATE_KEY_MAX_BYTES = 1024;
const STATE_VALUE_MAX_BYTES = 1_000_000;
const INBOX_MAX_PER_SENDER = 1024;
const DEFAULT_WARNING_THRESHOLD = 0.8;

export interface TestRuntime extends Runtime {
  /** Snapshot the internal world — useful for debugging a failed scenario. */
  inspect(id: AgentId): AgentState | undefined;
  /**
   * Pre-spawn an agent handle without running any hooks. Scenarios
   * that wire their own world up use the normal `.agent(id).spawn()`
   * path instead.
   */
  seed(fixture: AgentFixture): void;
}

export function createTestRuntime(): TestRuntime {
  const world = new Map<AgentId, AgentState>();

  function getOrFail(id: AgentId): AgentState {
    const s = world.get(id);
    if (!s || s.terminated) {
      throw meridianError(
        "MRD-CF-LC-002",
        `agent ${id} is not spawned on this runtime`,
      );
    }
    return s;
  }

  const agent = (id: AgentId): AgentRef => ({
    async spawn(config: SpawnConfig): Promise<AgentHandle> {
      if (!config.id || !config.domain) {
        throw meridianError(
          "MRD-CF-LC-004",
          "SpawnConfig.id and SpawnConfig.domain are required",
        );
      }
      if (config.id !== id) {
        throw meridianError(
          "MRD-CF-LC-005",
          `agent ref bound to ${id} received spawn for ${config.id}`,
        );
      }
      if (config.fromSnapshot) {
        throw meridianError(
          "MRD-CF-EX-002",
          "SpawnConfig.fromSnapshot rejected: snapshots not implemented in v0.1",
        );
      }
      const existing = world.get(id);
      if (existing && !existing.terminated) {
        if (existing.handle.domain !== config.domain) {
          throw meridianError(
            "MRD-CF-LC-001",
            `existing agent ${id}/${existing.handle.domain} on this runtime; cannot re-spawn as ${id}/${config.domain}`,
          );
        }
        return existing.handle;
      }
      const now = Date.now() as Timestamp;
      const handle: AgentHandle = {
        id,
        domain: config.domain,
        status: "running",
        spawnedAt: now,
      };
      world.set(id, freshState(handle));
      return handle;
    },
    async terminate(): Promise<void> {
      const s = world.get(id);
      if (!s) return;
      s.terminated = true;
      s.storage.clear();
      s.schedules.clear();
      s.inbox = [];
      s.nextSeqBySender.clear();
      s.wiTokens.clear();
      s.wiCost.clear();
    },
    async exists(): Promise<boolean> {
      const s = world.get(id);
      return Boolean(s && !s.terminated);
    },
    async get(): Promise<AgentHandle> {
      return getOrFail(id).handle;
    },

    async save(key: string, value: unknown): Promise<void> {
      const s = getOrFail(id);
      validateKey(key);
      validateValue(value);
      s.storage.set(key, structuredClone(value));
    },
    async load<T = unknown>(key: string): Promise<T | undefined> {
      const s = getOrFail(id);
      validateKey(key);
      const v = s.storage.get(key);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async delete(key: string): Promise<void> {
      const s = getOrFail(id);
      validateKey(key);
      s.storage.delete(key);
    },
    async list(opts?: ListOptions): Promise<ListResult> {
      const s = getOrFail(id);
      const prefix = opts?.prefix ?? "";
      const limit = opts?.limit ?? Infinity;
      const keys = Array.from(s.storage.keys())
        .filter((k) => !k.startsWith("__") && k.startsWith(prefix))
        .sort()
        .slice(0, limit);
      return { keys };
    },
    async incrementAtomic(key: string, delta = 1): Promise<number> {
      const s = getOrFail(id);
      validateKey(key);
      const prior = (s.storage.get(key) as number | undefined) ?? 0;
      const next = prior + delta;
      s.storage.set(key, next);
      return next;
    },

    async scheduleAt(when: Timestamp, payload?: unknown): Promise<ScheduleId> {
      const s = getOrFail(id);
      const now = Date.now();
      const delay = when - now;
      if (delay < MIN_DELAY_MS) {
        throw meridianError(
          "MRD-CF-SC-001",
          `scheduleAt delay ${delay}ms below 1000ms minimum`,
        );
      }
      if (delay > MAX_DELAY_MS) {
        throw meridianError(
          "MRD-CF-SC-002",
          `scheduleAt delay ${delay}ms above 365-day maximum`,
        );
      }
      const sid = crypto.randomUUID();
      s.schedules.set(sid, {
        id: sid,
        type: "once",
        payload,
        nextFireAt: when,
      });
      return sid;
    },
    async scheduleCron(cron: string, payload?: unknown): Promise<ScheduleId> {
      const s = getOrFail(id);
      let job: Cron;
      try {
        job = new Cron(cron);
      } catch (e) {
        throw meridianError(
          "MRD-CF-SC-003",
          `cron pattern "${cron}" rejected: ${(e as Error).message}`,
        );
      }
      const next = job.nextRun(new Date());
      if (!next) {
        throw meridianError(
          "MRD-CF-SC-003",
          `cron pattern "${cron}" produced no future run`,
        );
      }
      const sid = crypto.randomUUID();
      s.schedules.set(sid, {
        id: sid,
        type: "cron",
        cron,
        payload,
        nextFireAt: next.getTime(),
      });
      return sid;
    },
    async cancelSchedule(scheduleId: ScheduleId): Promise<void> {
      const s = getOrFail(id);
      if (!s.schedules.has(scheduleId)) {
        throw meridianError(
          "MRD-CF-SC-004",
          `scheduleId "${scheduleId}" not registered`,
        );
      }
      s.schedules.delete(scheduleId);
    },
    async listSchedules(): Promise<ScheduleInfo[]> {
      const s = getOrFail(id);
      return Array.from(s.schedules.values()).map((sch) => ({
        id: sch.id,
        agentId: id,
        type: sch.type,
        nextFireAt: sch.nextFireAt,
        cron: sch.cron,
        payload: sch.payload,
      }));
    },

    async send(
      toAgentId: AgentId,
      payload: Uint8Array,
    ): Promise<MessageReceipt> {
      getOrFail(id);
      validatePayload(payload);
      const recipient = world.get(toAgentId);
      if (!recipient || recipient.terminated) {
        throw meridianError(
          "MRD-CF-LC-002",
          `recipient ${toAgentId} not spawned on this runtime`,
        );
      }
      if (recipient.inbox.length >= INBOX_MAX_PER_SENDER) {
        throw meridianError(
          "MRD-CF-TR-003",
          `inbox from ${id} to ${toAgentId} at cap`,
        );
      }
      const nextSeq = (recipient.nextSeqBySender.get(id) ?? 0) + 1;
      recipient.nextSeqBySender.set(id, nextSeq);
      const msg: IncomingMessage = {
        messageId: `${id}::${nextSeq}`,
        fromAgentId: id,
        toAgentId,
        payload: new Uint8Array(payload),
        receivedAt: Date.now() as Timestamp,
      };
      recipient.inbox.push(msg);
      return { messageId: msg.messageId, queuedAt: msg.receivedAt };
    },
    async broadcast(
      selector: AgentSelector,
      payload: Uint8Array,
    ): Promise<BroadcastReceipt> {
      const sender = getOrFail(id);
      validatePayload(payload);
      const domain = selector.domain ?? sender.handle.domain;
      const recipients = Array.from(world.values()).filter(
        (s) =>
          !s.terminated && s.handle.id !== id && s.handle.domain === domain,
      );
      if (recipients.length === 0) {
        throw meridianError(
          "MRD-CF-TR-002",
          `broadcast found no recipients in domain "${domain}"`,
        );
      }
      const broadcastId = crypto.randomUUID();
      const queuedAt = Date.now() as Timestamp;
      for (const r of recipients) {
        const nextSeq = (r.nextSeqBySender.get(id) ?? 0) + 1;
        r.nextSeqBySender.set(id, nextSeq);
        r.inbox.push({
          messageId: `${id}::${nextSeq}`,
          fromAgentId: id,
          toAgentId: r.handle.id,
          payload: new Uint8Array(payload),
          receivedAt: queuedAt,
        });
      }
      return {
        broadcastId,
        recipientCount: recipients.length,
        queuedAt,
      };
    },
    async receiveAll(): Promise<IncomingMessage[]> {
      const s = getOrFail(id);
      return s.inbox.map((m) => ({ ...m, payload: new Uint8Array(m.payload) }));
    },
    async drainInbox(): Promise<IncomingMessage[]> {
      const s = getOrFail(id);
      const out = s.inbox.map((m) => ({
        ...m,
        payload: new Uint8Array(m.payload),
      }));
      s.inbox = [];
      return out;
    },

    async setLimits(limits: ResourceLimits): Promise<void> {
      getOrFail(id).limits = { ...limits };
    },
    async getLimits(): Promise<ResourceLimits> {
      return { ...getOrFail(id).limits };
    },
    async getUsage(): Promise<ResourceUsage> {
      const s = getOrFail(id);
      return {
        limits: { ...s.limits },
        current: { ...s.usage },
        warnings: s.warnings.slice(),
      };
    },
    async reportTokens(
      n: number,
      attribution?: { workItemId?: string },
    ): Promise<void> {
      const s = getOrFail(id);
      if (n < 0) {
        throw meridianError(
          "MRD-CF-RS-003",
          `reportTokens(${n}) requires a non-negative count`,
        );
      }
      if (
        s.limits.maxTokensPerCall !== undefined &&
        n > s.limits.maxTokensPerCall
      ) {
        throw meridianError(
          "MRD-CF-RS-003",
          `reportTokens(${n}) exceeds maxTokensPerCall=${s.limits.maxTokensPerCall}`,
        );
      }
      const next = s.usage.tokensLifetime + n;
      if (
        s.limits.maxTokensTotal !== undefined &&
        next > s.limits.maxTokensTotal
      ) {
        throw meridianError(
          "MRD-CF-RS-001",
          `reportTokens would raise total to ${next}, exceeding maxTokensTotal=${s.limits.maxTokensTotal}`,
        );
      }
      s.usage.tokensLifetime = next;
      if (attribution?.workItemId) {
        s.wiTokens.set(
          attribution.workItemId,
          (s.wiTokens.get(attribution.workItemId) ?? 0) + n,
        );
      }
      maybeWarn(s, "tokens", next, s.limits.maxTokensTotal);
    },
    async reportCost(
      usd: number,
      attribution?: { workItemId?: string },
    ): Promise<void> {
      const s = getOrFail(id);
      if (usd < 0) {
        throw meridianError(
          "MRD-CF-RS-002",
          `reportCost(${usd}) requires a non-negative amount`,
        );
      }
      const next = s.usage.costUsdLifetime + usd;
      if (s.limits.maxCostUsd !== undefined && next > s.limits.maxCostUsd) {
        throw meridianError(
          "MRD-CF-RS-002",
          `reportCost would raise total to $${next.toFixed(4)}, exceeding maxCostUsd=$${s.limits.maxCostUsd}`,
        );
      }
      s.usage.costUsdLifetime = next;
      if (attribution?.workItemId) {
        s.wiCost.set(
          attribution.workItemId,
          (s.wiCost.get(attribution.workItemId) ?? 0) + usd,
        );
      }
      maybeWarn(s, "cost", next, s.limits.maxCostUsd);
    },
    async getUsageByWorkItem(
      workItemId?: string,
    ): Promise<Array<{ workItemId: string; tokens: number; costUsd: number }>> {
      const s = getOrFail(id);
      if (workItemId) {
        const tokens = s.wiTokens.get(workItemId) ?? 0;
        const costUsd = s.wiCost.get(workItemId) ?? 0;
        if (tokens === 0 && costUsd === 0) return [];
        return [{ workItemId, tokens, costUsd }];
      }
      const ids = new Set<string>([...s.wiTokens.keys(), ...s.wiCost.keys()]);
      const out = Array.from(ids, (wid) => ({
        workItemId: wid,
        tokens: s.wiTokens.get(wid) ?? 0,
        costUsd: s.wiCost.get(wid) ?? 0,
      }));
      out.sort((a, b) => b.costUsd - a.costUsd);
      return out;
    },

    snapshotState(): Promise<never> {
      return Promise.reject(
        meridianError(
          "MRD-CF-EX-001",
          "snapshotState is @experimental and not implemented in v0.1",
        ),
      );
    },
    setPermissions(): Promise<never> {
      return Promise.reject(
        meridianError(
          "MRD-CF-EX-004",
          "setPermissions is @experimental and not implemented in v0.1",
        ),
      );
    },
    getPermissions(): Promise<never> {
      return Promise.reject(
        meridianError(
          "MRD-CF-EX-005",
          "getPermissions is @experimental and not implemented in v0.1",
        ),
      );
    },
  });

  return {
    kind: "in-memory",
    agent,
    async runAlarm(id: AgentId): Promise<void> {
      const s = world.get(id);
      if (!s || s.terminated) return;
      const now = Date.now();
      for (const [sid, sch] of s.schedules) {
        if (sch.nextFireAt <= now) {
          if (sch.type === "once") {
            s.schedules.delete(sid);
          } else {
            const next = new Cron(sch.cron!).nextRun(new Date(now));
            if (next) {
              sch.nextFireAt = next.getTime();
            } else {
              s.schedules.delete(sid);
            }
          }
        }
      }
    },
    async sleep(ms: number): Promise<void> {
      await new Promise((r) => setTimeout(r, ms));
    },
    inspect(id: AgentId): AgentState | undefined {
      return world.get(id);
    },
    seed(fixture: AgentFixture): void {
      const now = Date.now() as Timestamp;
      world.set(
        fixture.id,
        freshState({
          id: fixture.id,
          domain: fixture.domain,
          status: "running",
          spawnedAt: now,
        }),
      );
    },
  };
}

function freshState(handle: AgentHandle): AgentState {
  return {
    handle,
    storage: new Map(),
    schedules: new Map(),
    inbox: [],
    nextSeqBySender: new Map(),
    limits: {},
    usage: {
      memoryMB: 0,
      cpuMsLifetime: 0,
      tokensLifetime: 0,
      costUsdLifetime: 0,
      activeOperations: 0,
    },
    warnings: [],
    wiTokens: new Map(),
    wiCost: new Map(),
    terminated: false,
  };
}

function validateKey(key: string): void {
  if (key.startsWith("__")) {
    throw meridianError(
      "MRD-CF-ST-003",
      `state key "${key}" uses reserved prefix "__"`,
    );
  }
  if (new TextEncoder().encode(key).byteLength > STATE_KEY_MAX_BYTES) {
    throw meridianError(
      "MRD-CF-ST-001",
      `state key exceeds ${STATE_KEY_MAX_BYTES}-byte cap`,
    );
  }
}

function validateValue(value: unknown): void {
  const json = JSON.stringify(value);
  if (json && json.length > STATE_VALUE_MAX_BYTES) {
    throw meridianError(
      "MRD-CF-ST-002",
      `state value exceeds ${STATE_VALUE_MAX_BYTES}-byte cap`,
    );
  }
}

function validatePayload(payload: Uint8Array): void {
  if (payload.byteLength > PAYLOAD_MAX_BYTES) {
    throw meridianError(
      "MRD-CF-TR-001",
      `payload ${payload.byteLength} bytes exceeds 1 MB wire limit`,
    );
  }
}

function maybeWarn(
  s: AgentState,
  type: ResourceWarning["type"],
  current: number,
  limit: number | undefined,
): void {
  if (limit === undefined || limit <= 0) return;
  const ratio = current / limit;
  if (ratio < DEFAULT_WARNING_THRESHOLD) return;
  const filtered = s.warnings.filter((w) => w.type !== type);
  filtered.push({
    type,
    threshold: ratio,
    triggeredAt: Date.now() as Timestamp,
  });
  s.warnings = filtered;
}
