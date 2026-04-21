/**
 * Core types used across all Meridian primitives.
 * These are the building blocks that every other type references.
 */

/** Globally unique identifier for an agent within a runtime. */
export type AgentId = string;

/** Globally unique identifier for a domain. */
export type DomainId = string;

/** Identifier for a scheduled invocation. */
export type ScheduleId = string;

/** Identifier for a work item or correlation key. */
export type WorkItemId = string;

/** Identifier for a state snapshot. @experimental */
export type SnapshotId = string;

/** Monotonic timestamp in milliseconds since Unix epoch. */
export type Timestamp = number;

/** Cost denomination. v1.0 supports USD only. */
export interface Cost {
  amount: number;
  currency: "USD";
  attributedTo?: WorkItemId;
}

/** Resource ceiling declaration. All fields optional. */
export interface ResourceLimits {
  maxMemoryMB?: number;
  maxCpuMs?: number;
  maxTokensPerCall?: number;
  maxTokensTotal?: number;
  maxCostUsd?: number;
  maxConcurrency?: number;
}

/** Runtime capability requirements for agent placement. @experimental */
export interface RuntimeRequirements {
  class: "isolate" | "sandbox" | "any";
  filesystem?: boolean;
  shell?: boolean;
  networkControl?: boolean;
  minMemoryMB?: number;
  snapshotSupport?: boolean;
}
