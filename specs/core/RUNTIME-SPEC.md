# Meridian Runtime Specification

**Version:** 1.0.0-draft.3
**Status:** Draft for review
**Date:** April 2026
**License:** CC BY 4.0

> Meridian is the protocol for systems where agents operate, humans steward, and costs are visible in real time. It defines the wire format, runtime primitives, feedback contract, and skill declaration that let mixed agent-and-human organizations run lean — small teams of stewards setting direction and gating decisions, while domain agents handle operational work within visible budgets.

This document defines the Meridian Runtime layer: the six primitives any platform must implement to host Meridian-compatible agents — lifecycle, state persistence, scheduling, message transport, resource limits, and observability.

---

## 1. About this document

This is the formal specification for the Meridian Runtime layer — the contract any platform must implement to host Meridian-compatible agents. It is one component of the broader Meridian standard, which also includes the protocol, feedback contract, work item schema, domain model, and skill declaration specifications. This document defines only the runtime layer.

This specification is **language-agnostic in intent**. Function signatures are expressed in TypeScript for clarity and because the reference implementation is TypeScript on Cloudflare. Implementations in other languages (Go, Rust, Python, Java) are welcome and encouraged. Where the language differs, the type system should preserve the contract semantics: required fields stay required, error categories stay distinct, lifecycle guarantees stay enforceable.

### What this spec covers

- The six runtime primitives and their function signatures
- Type definitions for all inputs, outputs, and errors
- Lifecycle guarantees the runtime must provide
- Versioning rules and stability tiers
- Conformance requirements

### What this spec does not cover

- The Meridian protocol wire format (separate spec)
- The feedback contract (separate spec)
- How agents are written or what they do
- Any implementation choices the runtime is free to make

---

## 2. Conformance

A runtime is **Meridian Runtime v1.0 compliant** if it implements every primitive marked `stable` in this document with the documented signature and semantics, and passes the official conformance test suite published alongside the reference implementation.

A runtime **may** also implement primitives marked `experimental`. Experimental primitives may change in minor versions and must be explicitly opted into by agent code.

A runtime **may not** add required parameters to stable primitives, change error categories, or weaken lifecycle guarantees while claiming v1.0 compliance.

### Stability tiers

- **stable** — frozen for the v1.x line. Breaking changes require a v2.0 spec.
- **experimental** — may change in minor versions (1.1, 1.2). Marked clearly in agent-facing APIs.
- **deprecated** — slated for removal in the next major version. Implementations must still support it within v1.x.

---

## 3. Core types

These types are used throughout the primitives. All are stable in v1.0.

```typescript
/**
 * Globally unique identifier for an agent within a runtime.
 * Format: opaque string, 1-256 characters, UTF-8.
 * The runtime is responsible for collision prevention within its scope.
 */
type AgentId = string;

/**
 * Globally unique identifier for a domain.
 * Format: opaque string, 1-256 characters, UTF-8.
 */
type DomainId = string;

/**
 * Identifier for a scheduled invocation, returned by schedule().
 * Used to cancel the invocation later.
 */
type ScheduleId = string;

/**
 * Identifier for a work item or correlation key.
 * Used for cost attribution and tracing.
 */
type WorkItemId = string;

/**
 * Monotonic timestamp in milliseconds since Unix epoch.
 * Runtimes must provide millisecond precision or better.
 */
type Timestamp = number;

/**
 * Cost denomination. v1.0 supports USD only.
 * Future versions may support other currencies and credit systems.
 */
type Cost = {
  amount: number; // floating point, USD
  currency: "USD"; // locked to USD in v1.0
  attributedTo?: WorkItemId;
};

/**
 * Resource ceiling declaration. All fields optional.
 * The runtime enforces these limits and terminates agents that exceed them.
 */
type ResourceLimits = {
  maxMemoryMB?: number; // hard memory ceiling
  maxCpuMs?: number; // total CPU time per invocation
  maxTokensPerCall?: number; // tokens per single LLM call
  maxTokensTotal?: number; // tokens across the agent's lifetime
  maxCostUsd?: number; // hard cost ceiling, USD
  maxConcurrency?: number; // simultaneous in-flight operations
};

/**
 * Identifier for a state snapshot, returned by snapshotState().
 * Used to spawn new agents from a previous snapshot.
 *
 * @experimental
 */
type SnapshotId = string;

/**
 * Defines what services and operations an agent is allowed to access.
 * Permissions are enforced by the runtime's credential layer, not by
 * the agent itself. The agent never sees raw credentials.
 *
 * PermissionScope is separate from ResourceLimits. ResourceLimits
 * constrain how much an agent can consume. PermissionScope constrains
 * what an agent can touch.
 *
 * @experimental
 */
type PermissionScope = {
  /**
   * Service/method patterns the agent can invoke, using glob syntax.
   * e.g., ["crm.*", "support.getIssue", "dataWarehouse.query"]
   * An empty array means no service access.
   * A ["*"] means unrestricted (use with caution).
   */
  services: string[];

  /**
   * Tool categories the agent can use.
   * Runtimes define their own tool categories; this field provides
   * a standard way to restrict them.
   */
  tools?: Record<string, boolean>;

  /**
   * Domain(s) this permission scope applies to.
   * When empty, the scope applies to all domains the agent participates in.
   */
  domains?: DomainId[];
};

/**
 * Describes how an agent session was triggered.
 * The runtime may use this to select permission profiles
 * and configure audit behavior.
 *
 * @experimental
 */
type InvocationContext = {
  source: "interactive" | "webhook" | "scheduled" | "agent" | "system";
  sourceId?: string; // e.g., Slack thread ID, webhook event ID
  permissions?: PermissionScope; // overrides agent's default scope for this invocation
  auditLevel?: "full" | "summary" | "none";
};

/**
 * Declares what runtime capabilities an agent requires.
 * Used for placement decisions and marketplace filtering.
 *
 * Non-normative: this type is advisory. Runtimes SHOULD honor requirements
 * they can satisfy and MAY reject spawn requests they cannot meet, but the
 * spec does not mandate any specific enforcement behavior beyond returning
 * `UNAVAILABLE` when a declared requirement is unreachable. See section 7.
 *
 * @experimental
 */
type RuntimeRequirements = {
  class: "isolate" | "sandbox" | "any"; // isolate = lightweight (CF Workers), sandbox = full VM
  filesystem?: boolean; // needs filesystem access
  shell?: boolean; // needs shell/exec access
  networkControl?: boolean; // needs egress filtering or credential brokering
  minMemoryMB?: number;
  snapshotSupport?: boolean;
};

/**
 * Structured quality signal emitted after work is completed.
 * Goes beyond "did it work?" to provide machine-readable
 * validation results that downstream priority-scoring components
 * (see `../patterns/PRIORITY-ENGINE-SPEC.md`) and compound
 * learning layers can act on.
 *
 * @experimental
 */
type QualitySignal = {
  /** Overall result of quality validation. */
  result: "pass" | "fail" | "warn";

  /**
   * Numeric score between 0.0 and 1.0 for quality dimensions
   * that are continuous rather than binary.
   */
  score?: number;

  /** What category of quality was measured. */
  category:
    | "architectural"
    | "behavioral"
    | "performance"
    | "security"
    | "documentation"
    | "testing"
    | "entropy"
    | "custom";

  /**
   * Individual check results. Each check is a named validation
   * with a pass/fail outcome and optional details.
   */
  checks?: QualityCheck[];

  /** The work item this quality signal relates to, if any. */
  workItemId?: WorkItemId;

  /** Which enforcement tier produced this signal. */
  enforcementTier: EnforcementTier;
};

type QualityCheck = {
  name: string; // e.g., "no-circular-deps", "layer-boundary"
  result: "pass" | "fail" | "warn" | "skip";
  message?: string; // human-readable explanation
  file?: string; // file path, if applicable
  line?: number; // line number, if applicable
  fix?: string; // suggested fix description
  autoFixable: boolean; // can an agent fix this without human judgment?
};

/**
 * Enforcement tiers define how quality is validated.
 * The spec defines three tiers in a specific order:
 * mechanical checks run first, then agent review, then human gates.
 * Work only reaches the next tier if it passes the previous one.
 *
 * @experimental
 */
type EnforcementTier =
  /** Lint rules, structural tests, schema validation. Automated, deterministic, no judgment. */
  | "mechanical"
  /** Agent-driven review: specialized reviewer agents assess quality. Automated but non-deterministic. */
  | "agent_review"
  /** Human steward approval. Required for changes that pass mechanical and agent review but need human judgment. */
  | "human_gate";

/**
 * Structured competing context emitted when a proposed change
 * would affect a component that wants to provide counter-evidence.
 *
 * Competing context is machine-readable so downstream consumers
 * (including the priority engine; see
 * `../patterns/PRIORITY-ENGINE-SPEC.md` for the normative escalation
 * mechanism) can factor it into decisions rather than only surfacing
 * it for humans to read.
 *
 * @experimental
 */
type CompetingContext = {
  /** The agent or component providing the counter-evidence. */
  sourceAgentId: AgentId;

  /** The work item being contested. */
  contestedWorkItemId: WorkItemId;

  /** The type of concern being raised. */
  concern:
    | "dependency_risk"
    | "sla_risk"
    | "cost_risk"
    | "data_risk"
    | "performance_risk"
    | "security_risk"
    | "architectural_risk"
    | "custom";

  /** Machine-readable impact assessment. */
  impact: {
    /** How many downstream consumers are affected. */
    affectedConsumers?: number;
    /** Estimated revenue at risk, if quantifiable. */
    revenueAtRiskUsd?: number;
    /** Estimated blast radius: how far does the impact propagate? */
    blastRadius: "isolated" | "module" | "service" | "domain" | "system";
    /** Specific dependencies that would break. */
    breakingDependencies?: string[];
  };

  /** Human-readable argument for why this change is risky. */
  argument: string;

  /** Suggested alternative approach, if the competing agent has one. */
  suggestedAlternative?: string;

  /** Confidence in this competing context assessment. */
  confidence: number; // 0.0 to 1.0
};

/**
 * Standard error categories. Implementations must classify all errors
 * into one of these categories for consistent observability. Expressed
 * as a string literal union so values are zero-cost at runtime and
 * serialize directly to MessagePack / JSON.
 */
type ErrorCategory =
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "resource_exhausted"
  | "invalid_argument"
  | "timeout"
  | "unavailable"
  | "internal"
  | "cancelled";

/**
 * Standard runtime error. All primitives throw this on failure.
 */
class RuntimeError extends Error {
  category: ErrorCategory;
  retryable: boolean;
  cause?: Error;
  context?: Record<string, unknown>;
}
```

---

## 4. The six runtime primitives

### 4.1 Agent lifecycle (stable)

The lifecycle primitive manages the existence of agents. The runtime guarantees that an agent exists when called and is cleaned up when terminated. Lifecycle operations are idempotent where noted.

```typescript
interface AgentLifecycle {
  /**
   * Spawn a new agent instance.
   * If an agent with the given ID already exists and `idempotent` is true,
   * returns the existing agent without modification. If `idempotent` is false
   * (default), throws ALREADY_EXISTS.
   *
   * The runtime must persist the agent's existence before returning.
   * If spawn returns successfully, the agent is guaranteed to be addressable
   * by subsequent operations.
   *
   * @throws RuntimeError(ALREADY_EXISTS) if agent exists and idempotent=false
   * @throws RuntimeError(RESOURCE_EXHAUSTED) if runtime cannot allocate
   * @throws RuntimeError(INVALID_ARGUMENT) if config is malformed
   */
  spawn(config: SpawnConfig): Promise<AgentHandle>;

  /**
   * Suspend an agent. The agent stops processing new messages and scheduled
   * invocations, but its state is preserved. A suspended agent can be resumed.
   *
   * Suspension is idempotent: suspending an already-suspended agent is a no-op.
   *
   * @throws RuntimeError(NOT_FOUND) if no agent with this ID exists
   */
  suspend(id: AgentId): Promise<void>;

  /**
   * Resume a suspended agent. Pending messages and missed scheduled invocations
   * are delivered according to the runtime's delivery guarantees (see 4.4).
   *
   * Resume is idempotent: resuming an already-running agent is a no-op.
   *
   * @throws RuntimeError(NOT_FOUND) if no agent with this ID exists
   */
  resume(id: AgentId): Promise<void>;

  /**
   * Permanently terminate an agent. State is deleted. Pending scheduled
   * invocations are cancelled. In-flight messages are not delivered.
   *
   * Termination is idempotent and irreversible: terminating a non-existent
   * or already-terminated agent succeeds silently.
   */
  terminate(id: AgentId): Promise<void>;

  /**
   * Get a handle to an existing agent without spawning.
   * Used to send messages, query state, or check existence.
   *
   * @throws RuntimeError(NOT_FOUND) if no agent with this ID exists
   */
  get(id: AgentId): Promise<AgentHandle>;

  /**
   * Check if an agent exists. Does not throw on missing agents.
   */
  exists(id: AgentId): Promise<boolean>;

  /**
   * Snapshot the current state of an agent for later restoration.
   * The snapshot includes all persisted state (key-value pairs) and,
   * for sandbox-class runtimes, may include filesystem state.
   *
   * Returns a snapshot ID that can be passed to spawn() via fromSnapshot
   * to create a new agent initialized from this snapshot.
   *
   * Not all runtimes support snapshots. Runtimes that do not support
   * this method must throw UNAVAILABLE.
   *
   * @experimental
   * @throws RuntimeError(NOT_FOUND) if agent does not exist
   * @throws RuntimeError(UNAVAILABLE) if runtime does not support snapshots
   */
  snapshotState(id: AgentId): Promise<SnapshotId>;
}

type SpawnConfig = {
  id: AgentId;
  domain: DomainId;
  initialState?: Record<string, unknown>;
  fromSnapshot?: SnapshotId; // @experimental: spawn from a previous snapshot (overrides initialState)
  limits?: ResourceLimits;
  permissions?: PermissionScope; // @experimental: access control scope for this agent
  metadata?: Record<string, string>;
  idempotent?: boolean; // default false
};

type AgentHandle = {
  id: AgentId;
  domain: DomainId;
  status: "running" | "suspended" | "terminating";
  spawnedAt: Timestamp;
};
```

**Lifecycle guarantees:**

- After `spawn` returns successfully, the agent is durably persisted. A runtime crash must not lose the agent.
- After `terminate` returns, the agent's state is unrecoverable.
- Lifecycle transitions are atomic. An agent is either fully spawned or not spawned at all; partial states are not observable.
- The runtime must prevent race conditions between concurrent lifecycle operations on the same agent.
- _(experimental)_ When `fromSnapshot` is provided in `SpawnConfig`, `initialState` is ignored. The agent boots with the full state from the snapshot. Runtimes that do not support snapshots must throw `UNAVAILABLE` if `fromSnapshot` is set.
- _(experimental)_ When `permissions` is provided in `SpawnConfig`, the runtime must enforce the `PermissionScope` for the lifetime of the agent. Permission changes after spawn require `setPermissions()` (see section 4.5).

---

### 4.2 State persistence (stable)

The state primitive lets agents persist arbitrary structured data and retrieve it across invocations. The runtime is free to choose the storage backend (SQLite, DynamoDB, Postgres, in-memory with replication) as long as the contract holds.

```typescript
interface StatePersistence {
  /**
   * Save a value under a key in the agent's state namespace.
   * Each agent has an isolated namespace. Keys do not collide across agents.
   *
   * Values must be JSON-serializable. Binary data must be base64-encoded.
   * Maximum value size: 1 MB. Maximum key size: 1024 bytes.
   *
   * Saves are durable: when save() returns, the value is persisted and will
   * survive runtime restarts.
   *
   * @throws RuntimeError(INVALID_ARGUMENT) if value exceeds size limit
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   */
  save(agentId: AgentId, key: string, value: unknown): Promise<void>;

  /**
   * Load a value by key. Returns undefined if the key does not exist.
   * Does not throw on missing keys (use exists() to distinguish absence
   * from a stored undefined).
   *
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   */
  load<T = unknown>(agentId: AgentId, key: string): Promise<T | undefined>;

  /**
   * Delete a key. Idempotent: deleting a non-existent key succeeds.
   *
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   */
  delete(agentId: AgentId, key: string): Promise<void>;

  /**
   * List all keys in the agent's namespace, optionally filtered by prefix.
   * Returns up to `limit` keys (default 1000, max 10000). Use cursor for pagination.
   *
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   */
  list(agentId: AgentId, opts?: ListOptions): Promise<ListResult>;

  /**
   * Atomic transactional update. The function receives the current value
   * and returns the new value. The runtime guarantees the read-modify-write
   * sequence is atomic with respect to other operations on the same key.
   *
   * If the function throws, the update is aborted and the value is unchanged.
   *
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   * @throws Whatever the updater function throws
   */
  update<T>(
    agentId: AgentId,
    key: string,
    updater: (current: T | undefined) => T,
  ): Promise<T>;
}

type ListOptions = {
  prefix?: string;
  limit?: number; // default 1000, max 10000
  cursor?: string; // opaque pagination cursor
};

type ListResult = {
  keys: string[];
  cursor?: string; // present if more results exist
};
```

**State guarantees:**

- Writes are durable when `save()` returns.
- Reads after writes are consistent within a single agent (read-your-writes).
- Cross-agent state access is not permitted. Agents must communicate via messages.
- The runtime must isolate agent namespaces. An agent must not be able to read or write another agent's keys.

---

### 4.3 Scheduling (stable)

The scheduling primitive lets agents request future invocations. Schedules are durable and survive runtime restarts.

```typescript
interface Scheduling {
  /**
   * Schedule an invocation of the agent at a future time.
   * The runtime will deliver an "alarm" message to the agent when the time
   * arrives. The payload is opaque to the runtime and delivered as-is.
   *
   * Returns a ScheduleId that can be used to cancel the schedule.
   *
   * Minimum delay: 1 second. Maximum delay: 365 days.
   * Implementations may support shorter or longer ranges as extensions
   * but must support this range as the baseline.
   *
   * @throws RuntimeError(INVALID_ARGUMENT) if delay is out of range
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   */
  scheduleAt(
    agentId: AgentId,
    when: Timestamp,
    payload?: unknown,
  ): Promise<ScheduleId>;

  /**
   * Schedule a recurring invocation using a cron expression.
   * Cron format: standard 5-field (minute hour day month dayOfWeek) or
   * 6-field with seconds. Implementations must support 5-field at minimum.
   *
   * @throws RuntimeError(INVALID_ARGUMENT) if cron is malformed
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   */
  scheduleCron(
    agentId: AgentId,
    cron: string,
    payload?: unknown,
  ): Promise<ScheduleId>;

  /**
   * Cancel a previously scheduled invocation.
   * Idempotent: cancelling an already-cancelled or expired schedule succeeds.
   */
  cancel(scheduleId: ScheduleId): Promise<void>;

  /**
   * List all active schedules for an agent.
   *
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   */
  listSchedules(agentId: AgentId): Promise<ScheduleInfo[]>;
}

type ScheduleInfo = {
  id: ScheduleId;
  agentId: AgentId;
  type: "once" | "cron";
  nextFireAt: Timestamp;
  cron?: string; // present if type is "cron"
  payload?: unknown;
};
```

**Scheduling guarantees:**

- Scheduled invocations are durable. A runtime restart must not lose schedules.
- Delivery is at-least-once. The runtime may invoke the agent more than once for the same schedule under failure conditions; agent code must be idempotent or use the schedule ID for deduplication.
- Time precision is best-effort. The runtime delivers as close to the scheduled time as possible but offers no hard real-time guarantees. Agents must not rely on sub-second precision.
- A suspended agent's schedules are deferred until resume. Cron schedules that fire while suspended may be delivered as a single coalesced invocation on resume; agents must not assume each cron tick produces a separate invocation.

---

### 4.4 Message transport (stable)

The message transport primitive moves Meridian protocol messages between agents. The runtime is responsible for delivery; the protocol layer defines the message format.

```typescript
interface MessageTransport {
  /**
   * Send a message to a specific agent.
   * The payload is opaque to the runtime — typically a serialized Meridian
   * protocol frame, but the runtime does not inspect or validate it.
   *
   * Delivery is asynchronous. send() returns when the message is durably
   * queued for delivery, not when the recipient processes it.
   *
   * @throws RuntimeError(NOT_FOUND) if recipient agent does not exist
   * @throws RuntimeError(RESOURCE_EXHAUSTED) if queue is full
   * @throws RuntimeError(INVALID_ARGUMENT) if payload exceeds size limit
   */
  send(
    fromAgentId: AgentId,
    toAgentId: AgentId,
    payload: Uint8Array,
    options?: SendOptions,
  ): Promise<MessageReceipt>;

  /**
   * Broadcast a message to all agents matching a selector.
   * Common selectors: by domain, by capability tag, by metadata field.
   *
   * Broadcasts are best-effort. The runtime delivers to all matching agents
   * known at the time of the broadcast call. Agents that spawn after the
   * broadcast do not receive it.
   *
   * Returns the count of agents the message was queued for.
   */
  broadcast(
    fromAgentId: AgentId,
    selector: AgentSelector,
    payload: Uint8Array,
    options?: SendOptions,
  ): Promise<BroadcastReceipt>;

  /**
   * Register a handler for incoming messages on this agent.
   * The runtime invokes the handler each time a message is delivered.
   *
   * Only one handler may be registered per agent at a time. Subsequent
   * calls replace the previous handler.
   *
   * The handler must return within the agent's configured timeout, or
   * the runtime considers delivery failed and may retry per its policy.
   */
  onMessage(agentId: AgentId, handler: MessageHandler): Promise<void>;
}

type SendOptions = {
  ttlMs?: number; // message expires if not delivered within this window
  priority?: "low" | "normal" | "high";
  correlationId?: string; // for request/response patterns
  workItemId?: WorkItemId; // for cost attribution
};

type AgentSelector = {
  domain?: DomainId;
  metadata?: Record<string, string>;
  capabilities?: string[];
};

type MessageReceipt = {
  messageId: string;
  queuedAt: Timestamp;
};

type BroadcastReceipt = {
  broadcastId: string;
  recipientCount: number;
  queuedAt: Timestamp;
};

type IncomingMessage = {
  messageId: string;
  fromAgentId: AgentId;
  toAgentId: AgentId;
  payload: Uint8Array;
  receivedAt: Timestamp;
  correlationId?: string;
  workItemId?: WorkItemId;
};

type MessageHandler = (msg: IncomingMessage) => Promise<void>;
```

**Message transport guarantees:**

- **Delivery:** at-least-once for direct sends, best-effort for broadcasts. Exactly-once is not provided; agents must handle duplicate messages via correlation IDs or idempotent processing.
- **Ordering:** no global ordering. Messages from the same sender to the same recipient are delivered in order. Messages from different senders or to different recipients may be reordered.
- **Durability:** once `send()` returns successfully, the message will be delivered or expire via TTL. Runtime restarts must not lose messages in flight.
- **Maximum payload size:** 1 MB. Implementations may support larger payloads as extensions but must support 1 MB as the baseline.

---

### 4.5 Resource limits (stable)

The resource limits primitive declares and enforces ceilings on what an agent can consume. Limits are set at spawn time and may be updated. The runtime is responsible for enforcement. Permission scoping (experimental) is also managed through this interface.

```typescript
interface ResourceManagement {
  /**
   * Update the resource limits for an existing agent.
   * Limits take effect immediately for new operations. In-flight operations
   * complete under their previous limits.
   *
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   * @throws RuntimeError(INVALID_ARGUMENT) if limits are malformed
   */
  setLimits(agentId: AgentId, limits: ResourceLimits): Promise<void>;

  /**
   * Get the current limits and usage for an agent.
   *
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   */
  getUsage(agentId: AgentId): Promise<ResourceUsage>;

  /**
   * Register a callback for limit events.
   * The runtime invokes the callback when an agent crosses a configured
   * threshold (warning), or when it exceeds a hard limit (exceeded).
   */
  onLimitEvent(agentId: AgentId, handler: LimitEventHandler): Promise<void>;

  /**
   * Update the permission scope for an existing agent.
   * Takes effect immediately for new operations.
   *
   * When called with an InvocationContext, the permissions apply only
   * to that invocation session. When called without, they replace the
   * agent's default permissions.
   *
   * @experimental
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   * @throws RuntimeError(INVALID_ARGUMENT) if scope is malformed
   */
  setPermissions(
    agentId: AgentId,
    permissions: PermissionScope,
    context?: InvocationContext,
  ): Promise<void>;

  /**
   * Get the current effective permission scope for an agent.
   * If an InvocationContext is active, returns the intersection of
   * the agent's base permissions and the invocation-scoped permissions.
   *
   * @experimental
   * @throws RuntimeError(NOT_FOUND) if the agent does not exist
   */
  getPermissions(agentId: AgentId): Promise<PermissionScope>;
}

type ResourceUsage = {
  limits: ResourceLimits;
  current: {
    memoryMB: number;
    cpuMsLifetime: number;
    tokensLifetime: number;
    costUsdLifetime: number;
    activeOperations: number;
  };
  warnings: ResourceWarning[];
};

type ResourceWarning = {
  type: "memory" | "cpu" | "tokens" | "cost" | "concurrency";
  threshold: number; // 0.0 to 1.0, fraction of limit
  triggeredAt: Timestamp;
};

type LimitEvent = {
  agentId: AgentId;
  type: "warning" | "exceeded";
  resource: "memory" | "cpu" | "tokens" | "cost" | "concurrency";
  current: number;
  limit: number;
  timestamp: Timestamp;
};

type LimitEventHandler = (event: LimitEvent) => Promise<void>;
```

**Resource limit guarantees:**

- Hard limits are enforced. An agent that exceeds `maxMemoryMB`, `maxCostUsd`, or `maxTokensTotal` must be terminated by the runtime, with the reason recorded.
- Cost attribution: when an operation is tagged with a `workItemId`, the runtime must attribute the cost to that work item in addition to the agent's lifetime total.
- Warning thresholds (e.g., 80% of limit) emit `LimitEvent` with type `warning` but do not terminate the agent. This gives agents and operators a chance to react before hitting the hard ceiling.
- Limit checks must be observable via `getUsage()` in real-time, not on a delayed schedule. The latency between resource consumption and `getUsage()` reflecting it must be under 1 second.
- _(experimental)_ Permission scopes are enforced structurally by the runtime's credential layer, not by model behavior. An agent with a `PermissionScope` restricting it to `["crm.search*"]` must not be able to invoke `crm.delete` regardless of what code it generates. The runtime must return `PERMISSION_DENIED` for out-of-scope operations.
- _(experimental)_ Invocation-scoped permissions are computed as the intersection of the agent's base permissions and the invocation's `PermissionScope`. The effective scope is always equal to or narrower than the agent's base scope; invocation context cannot escalate permissions beyond the base.

---

### 4.6 Observability hooks (stable)

The observability primitive emits logs, metrics, and traces in a standard format. Every Meridian-compatible runtime exposes the same telemetry shape so that dashboards, alerting, and the feedback loop work identically across adapters.

```typescript
interface Observability {
  /**
   * Emit a structured log entry.
   * Logs are buffered and flushed asynchronously. log() does not block.
   */
  log(entry: LogEntry): void;

  /**
   * Record a metric value.
   * Metric names follow dotted notation: "agent.requests.total".
   * Tags are key-value pairs for dimensionality.
   */
  metric(name: string, value: number, tags?: Record<string, string>): void;

  /**
   * Start a trace span. Returns a span handle that must be ended with end().
   * Spans may be nested to represent call hierarchies.
   */
  startSpan(name: string, parentSpanId?: string): Span;
}

type LogEntry = {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  agentId?: AgentId;
  domain?: DomainId;
  workItemId?: WorkItemId;
  timestamp: Timestamp;
  fields?: Record<string, unknown>;
};

interface Span {
  spanId: string;
  traceId: string;

  /** Add a key-value attribute to the span. */
  setAttribute(key: string, value: string | number | boolean): void;

  /** Add a timestamped event to the span. */
  addEvent(name: string, attributes?: Record<string, unknown>): void;

  /** End the span. Must be called exactly once. */
  end(): void;
}
```

**Observability guarantees:**

- All telemetry emissions are non-blocking. `log()` and `metric()` must not throw or wait on I/O.
- Telemetry is best-effort. Implementations may drop telemetry under extreme load but must record drops as a separate metric.
- The runtime must include `agentId`, `domain`, and `workItemId` (when present) as automatic dimensions on all telemetry, so feedback consumers can correlate without explicit tagging.
- Telemetry format is OpenTelemetry-compatible at the wire level. Implementations may use OpenTelemetry SDKs internally, but the agent-facing interface above is the spec contract.

---

## 5. Versioning rules

Meridian Runtime follows semantic versioning with these specific rules:

**Major versions (1.x → 2.x):** Breaking changes to stable primitives. New required parameters. Removed methods. Changed error semantics. Major versions are rare and require community review.

**Minor versions (1.0 → 1.1):** Additive changes. New optional parameters. New experimental primitives. Promoting experimental primitives to stable. Existing v1.0 agents and adapters must continue to work without modification.

**Patch versions (1.0.0 → 1.0.1):** Clarifications, typo fixes, non-normative documentation improvements. No behavioral changes.

### Compatibility commitments

- An adapter that conforms to v1.0 will continue to host agents written against v1.0 indefinitely, even as v1.1, v1.2, and so on are published.
- An agent written against v1.0 will run unchanged on any v1.x adapter.
- Experimental primitives are explicitly opt-in. Agents that do not use experimental primitives cannot break when those primitives change.
- The conformance test suite is versioned alongside the spec. v1.0 conformance is determined by the v1.0 test suite.

---

## 6. Conformance testing

A separate `meridian-runtime-conformance` test suite is published alongside this specification. Implementations claiming v1.0 compliance must pass all tests marked `required` in that suite.

Test categories:

- **Lifecycle correctness** — spawn, suspend, resume, terminate semantics
- **State isolation and durability** — cross-agent isolation, crash recovery
- **Schedule precision and durability** — ordering, restart recovery
- **Message delivery guarantees** — at-least-once, ordering within sender/recipient pair
- **Resource enforcement** — termination on hard limit, warning emission
- **Observability completeness** — automatic dimensions, non-blocking emission
- **Error categorization** — all errors map to documented categories
- _(experimental)_ **Permission enforcement** — PermissionScope restricts service access, invocation context narrows scope
- _(experimental)_ **Snapshot lifecycle** — snapshotState captures state, fromSnapshot restores it, UNAVAILABLE on unsupported runtimes
- _(experimental)_ **Quality signal validation** — QualitySignal structure is well-formed, enforcement tiers are correctly classified, check results contain required fields
- _(experimental)_ **Competing context format** — CompetingContext carries machine-readable impact assessment, confidence score, and structured concern type

Implementations may publish their conformance test results. The Meridian project maintains a public registry of conformant implementations.

---

## 7. Implementation guidance

This section is non-normative. It documents common patterns for implementers but does not constrain how a runtime is built.

### State backend choice

The state primitive can be backed by any storage system that provides atomic key-value operations within an agent's namespace. Common choices:

- **SQLite per agent** (used by the Cloudflare reference adapter via Durable Objects). Excellent isolation, low latency, embedded. Best for runtimes that already provide per-agent compute isolation.
- **Shared Postgres or DynamoDB with namespace prefixing.** Better for runtimes that pool agents. Requires careful index design.
- **In-memory with replication.** Highest performance, requires solving durability separately.

### Message transport choice

- **Direct in-process calls** (used by Durable Objects when the recipient is in the same isolate). Lowest latency.
- **Cloud message queues** (SQS, Cloudflare Queues, NATS, RabbitMQ). Good for cross-region or cross-runtime delivery.
- **gRPC or WebSocket fanout.** Good for runtimes that need real-time bidirectional streams.

### Scheduling backend choice

- **Native alarm primitives** (Durable Objects alarms, AWS EventBridge Scheduler). Lowest operational burden.
- **Database-backed queue with poller.** Universal but requires careful design to avoid thundering herds.
- **Distributed scheduler** (Temporal, Cadence). Good when scheduling complexity is high.

### Cost attribution

Implementations should track cost at the operation level and roll up to agent and work-item totals asynchronously. Real-time accuracy is not required as long as `getUsage()` reflects costs within the 1-second latency budget.

### Credential management

The runtime may implement credential brokering to ensure agents never directly handle sensitive API keys, tokens, or secrets. Two patterns are common in production:

**Integration proxy.** The agent's execution environment receives a proxy URL and a short-lived session token. All external service calls route through the proxy, which validates the session token, checks the agent's `PermissionScope`, and injects real credentials before forwarding the request. The agent never sees the actual API key.

**Network-level brokering.** For a small set of integrations (model providers, code hosting), the runtime intercepts outbound HTTP requests at the network layer and injects credentials on egress. The agent's environment variable contains a placeholder string. The actual key is injected transparently before the request leaves the execution environment.

In both patterns, the `PermissionScope` determines which services and methods are accessible. The credential layer enforces this structurally, not through model behavior. This is defense in depth: the system makes unauthorized access structurally impossible, regardless of what code the agent generates.

Runtimes that implement credential brokering should expose a `CredentialBroker` interface as a runtime extension (not a core primitive), since not all runtime environments support network-level interception.

### Runtime classes

In practice, runtimes fall into two classes with fundamentally different capability profiles:

**Isolate-class runtimes.** Fast cold starts (milliseconds). Limited memory (128 MB typical). No filesystem. No shell access. State via key-value storage. Best for lightweight, always-on agents that observe, report, and coordinate. Example: Cloudflare Durable Objects.

**Sandbox-class runtimes.** Slower cold starts (seconds, mitigated by snapshots). Full memory (GBs). Full filesystem with code repositories. Shell access. Network-level security controls. Best for complex, task-oriented agents that need to read code, run tests, or execute multi-step workflows. Example: Browserbase sandboxes, Anthropic Managed Agents, E2B.

The `RuntimeRequirements` type (experimental; see section 3) allows agents to declare which runtime class they need. Treatment is non-normative: adapters use it for placement decisions, marketplaces use it to filter compatible runtimes when deploying an agent. A Meridian system may run both runtime classes simultaneously, with lightweight observer agents on isolates and heavyweight task agents in sandboxes. Runtimes SHOULD honor requirements they can satisfy and MAY reject spawn requests they cannot meet by returning `UNAVAILABLE`; the spec does not mandate any specific enforcement behavior beyond that.

---

## 8. Open questions for v1.0

This section tracks unresolved questions during the draft period. Each will be resolved before v1.0 is finalized.

- **Q1: Should `update()` support optimistic concurrency tokens in addition to the closure form?** Some implementations may prefer ETag-style updates for cache-friendliness.
- **Q2: Should `broadcast()` guarantee delivery to all matching agents, or remain best-effort?** Best-effort is simpler but limits use cases.
- **Q3: Should the spec define a standard way to declare which experimental primitives an agent uses?** Useful for tooling but adds complexity.
- **Q4: Cost denomination beyond USD.** Multi-currency support is out of scope for v1.0 but may be needed for international adapters in v1.1.
- **Q5: Should `PermissionScope` support dynamic permission escalation with steward approval?** An agent might need to request elevated permissions mid-task. The flow would be: agent requests escalation via the feedback contract, steward approves via a gate, runtime updates the session's `PermissionScope`. This creates a clean pattern for human-in-the-loop access control.
- **Q6: Should the spec define a standard `CredentialBroker` extension interface?** Currently non-normative guidance. If multiple adapters implement credential brokering, a standard interface would enable portable security policies across runtimes.
- **Q7: Should sandbox-class runtimes declare their capabilities separately from lightweight runtimes?** A Cloudflare isolate and a full Linux VM have fundamentally different capability profiles (filesystem access, shell execution, network control). Agents may need to declare which runtime class they require, and the placement layer needs to match agents to capable runtimes.
- **Q8: Should `QualitySignal` be promoted from optional to expected feedback?** Harness Engineering's production experience suggests that quality signals with structured check results are essential for compound learning, not just nice-to-have. If the system can't measure quality, it can't improve. Counter-argument: not every agent produces work that has a meaningful quality dimension.
- **Q9: Should the spec define standard quality check names?** Checks like `no-circular-deps`, `layer-boundary`, `test-coverage`, and `documentation-coverage` recur across codebases. A standard vocabulary would enable cross-project quality dashboards and marketplace quality certifications. Counter-argument: adds spec surface area and may not generalize beyond software engineering.
- **Q10: Should `CompetingContext` trigger automatic priority recalculation, or just surface information?** **RESOLVED** (v1.0-draft.5): Yes for the escalation pattern. `CompetingContext` with `impact.blastRadius ∈ {"service", "domain", "system"}` triggers a normative escalation path defined in [`../patterns/PRIORITY-ENGINE-SPEC.md`](../patterns/PRIORITY-ENGINE-SPEC.md). Automatic score adjustment for smaller blast radii is reference-implementation-defined; see [`@loom-loyalty/meridian-priority-reference`](../../packages/priority-reference/). Other implementations may diverge.

Feedback on these questions is welcome via the Meridian RFC process.

---

## 9. Glossary

- **Adapter** — A platform-specific implementation of this spec. The Cloudflare adapter is the reference implementation.
- **Agent** — A long-lived addressable computation managed by the runtime. Agents have state, can be scheduled, and exchange messages.
- **Competing context** — Structured counter-evidence emitted by a component when a proposed change would affect it. Machine-readable so downstream consumers (including the priority engine; see [`../patterns/PRIORITY-ENGINE-SPEC.md`](../patterns/PRIORITY-ENGINE-SPEC.md)) can factor it into decisions. Experimental in v1.0.
- **Credential brokering** — A pattern where the runtime holds real API credentials and injects them on behalf of agents, so agents never directly handle secrets. See section 7.
- **Domain** — An organizational grouping of agents and humans, defined in the Meridian Domain Model spec.
- **Enforcement tier** — One of three levels of quality validation: mechanical (automated, deterministic), agent review (automated, non-deterministic), or human gate (steward approval). Experimental in v1.0.
- **Invocation context** — Metadata describing how an agent session was triggered (interactive, webhook, scheduled, agent-to-agent), used to select permission profiles. Experimental in v1.0.
- **Isolate-class runtime** — A lightweight runtime with fast cold starts, limited memory, and no filesystem. Example: Cloudflare Workers.
- **Permission scope** — A declaration of which services, methods, and tools an agent is allowed to access. Orthogonal to resource limits. Experimental in v1.0.
- **Primitive** — One of the six top-level capabilities defined in this spec.
- **Quality signal** — A structured report of quality validation results with individual check outcomes, scores, fix suggestions, and enforcement tier classification. Experimental in v1.0.
- **Runtime** — The combination of an adapter and the underlying platform it runs on.
- **Sandbox-class runtime** — A heavyweight runtime with full filesystem, shell access, and network-level security. Example: Browserbase sandboxes, E2B.
- **Snapshot** — A captured point-in-time image of an agent's state (and optionally filesystem) that can be used to spawn new agents with warm starts. Experimental in v1.0.
- **Stable / experimental / deprecated** — Stability tiers. See section 2.
- **Work item** — A unit of work tracked by the Meridian system, defined in the Meridian Work Item Schema spec.

---

_This document is a draft. Comments, corrections, and proposed changes are welcome via pull request to the meridian-spec repository._
