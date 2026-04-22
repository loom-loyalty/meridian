/**
 * Runtime primitive interfaces.
 * These are the six contracts any platform must implement
 * to host Meridian-compatible agents.
 */

import type {
  AgentId,
  DomainId,
  ScheduleId,
  SnapshotId,
  WorkItemId,
  Timestamp,
  ResourceLimits,
} from "./primitives.js";
import type { PermissionScope, InvocationContext } from "./permissions.js";
import type { AgentSelector } from "./wire.js";

// ── Agent Lifecycle ──────────────────────────────────────

export interface SpawnConfig {
  id: AgentId;
  domain: DomainId;
  initialState?: Record<string, unknown>;
  fromSnapshot?: SnapshotId;
  limits?: ResourceLimits;
  permissions?: PermissionScope;
  metadata?: Record<string, string>;
  idempotent?: boolean;
  /**
   * Tenant identifier for multi-tenant runtimes. When omitted, the
   * runtime treats the agent as single-tenant (implementation-defined
   * default, typically `"default"`). Runtimes that support tenancy
   * MUST scope DO/registry/state storage by this value so two agents
   * with the same `id` under different tenants stay isolated.
   */
  tenantId?: string;
}

export interface AgentHandle {
  id: AgentId;
  domain: DomainId;
  status: "running" | "suspended" | "terminating";
  spawnedAt: Timestamp;
  /**
   * Tenant identifier if the runtime is multi-tenant. Absent on
   * handles from single-tenant runtimes.
   */
  tenantId?: string;
}

export interface AgentLifecycle {
  spawn(config: SpawnConfig): Promise<AgentHandle>;
  suspend(id: AgentId): Promise<void>;
  resume(id: AgentId): Promise<void>;
  terminate(id: AgentId): Promise<void>;
  get(id: AgentId): Promise<AgentHandle>;
  exists(id: AgentId): Promise<boolean>;
  /** @experimental */
  snapshotState(id: AgentId): Promise<SnapshotId>;
}

// ── State Persistence ────────────────────────────────────

export interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

export interface ListResult {
  keys: string[];
  cursor?: string;
}

export interface StatePersistence {
  save(agentId: AgentId, key: string, value: unknown): Promise<void>;
  load<T = unknown>(agentId: AgentId, key: string): Promise<T | undefined>;
  delete(agentId: AgentId, key: string): Promise<void>;
  list(agentId: AgentId, opts?: ListOptions): Promise<ListResult>;
  update<T>(
    agentId: AgentId,
    key: string,
    updater: (current: T | undefined) => T,
  ): Promise<T>;
}

// ── Scheduling ───────────────────────────────────────────

export interface ScheduleInfo {
  id: ScheduleId;
  agentId: AgentId;
  type: "once" | "cron";
  nextFireAt: Timestamp;
  cron?: string;
  payload?: unknown;
}

export interface Scheduling {
  scheduleAt(
    agentId: AgentId,
    when: Timestamp,
    payload?: unknown,
  ): Promise<ScheduleId>;
  scheduleCron(
    agentId: AgentId,
    cron: string,
    payload?: unknown,
  ): Promise<ScheduleId>;
  cancel(scheduleId: ScheduleId): Promise<void>;
  listSchedules(agentId: AgentId): Promise<ScheduleInfo[]>;
}

// ── Message Transport ────────────────────────────────────

export interface SendOptions {
  ttlMs?: number;
  priority?: "low" | "normal" | "high";
  correlationId?: string;
  workItemId?: WorkItemId;
}

export interface MessageReceipt {
  messageId: string;
  queuedAt: Timestamp;
}

export interface BroadcastReceipt {
  broadcastId: string;
  recipientCount: number;
  queuedAt: Timestamp;
}

export interface IncomingMessage {
  messageId: string;
  fromAgentId: AgentId;
  toAgentId: AgentId;
  payload: Uint8Array;
  receivedAt: Timestamp;
  correlationId?: string;
  workItemId?: WorkItemId;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface MessageTransport {
  send(
    fromAgentId: AgentId,
    toAgentId: AgentId,
    payload: Uint8Array,
    options?: SendOptions,
  ): Promise<MessageReceipt>;
  broadcast(
    fromAgentId: AgentId,
    selector: AgentSelector,
    payload: Uint8Array,
    options?: SendOptions,
  ): Promise<BroadcastReceipt>;
  onMessage(agentId: AgentId, handler: MessageHandler): Promise<void>;
}

// ── Resource Management ──────────────────────────────────

export interface ResourceUsage {
  limits: ResourceLimits;
  current: {
    memoryMB: number;
    cpuMsLifetime: number;
    tokensLifetime: number;
    costUsdLifetime: number;
    activeOperations: number;
  };
  warnings: ResourceWarning[];
}

export interface ResourceWarning {
  type: "memory" | "cpu" | "tokens" | "cost" | "concurrency";
  threshold: number;
  triggeredAt: Timestamp;
}

export interface LimitEvent {
  agentId: AgentId;
  type: "warning" | "exceeded";
  resource: "memory" | "cpu" | "tokens" | "cost" | "concurrency";
  current: number;
  limit: number;
  timestamp: Timestamp;
}

export type LimitEventHandler = (event: LimitEvent) => Promise<void>;

export interface ResourceManagement {
  setLimits(agentId: AgentId, limits: ResourceLimits): Promise<void>;
  getUsage(agentId: AgentId): Promise<ResourceUsage>;
  onLimitEvent(agentId: AgentId, handler: LimitEventHandler): Promise<void>;
  /** @experimental */
  setPermissions(
    agentId: AgentId,
    permissions: PermissionScope,
    context?: InvocationContext,
  ): Promise<void>;
  /** @experimental */
  getPermissions(agentId: AgentId): Promise<PermissionScope>;
}

// ── Observability ────────────────────────────────────────

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  agentId?: AgentId;
  domain?: DomainId;
  workItemId?: WorkItemId;
  timestamp: Timestamp;
  fields?: Record<string, unknown>;
}

export interface Span {
  spanId: string;
  traceId: string;
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, unknown>): void;
  end(): void;
}

export interface Observability {
  log(entry: LogEntry): void;
  metric(name: string, value: number, tags?: Record<string, string>): void;
  startSpan(name: string, parentSpanId?: string): Span;
}
