/**
 * Domain model types.
 * Domains are organizational primitives based on accountability.
 */

import type { AgentId, DomainId, Timestamp } from "./primitives.js";
import type { DomainPriorityConfig } from "./work-item.js";

export interface Domain {
  id: DomainId;
  name: string;
  description?: string;
  stewards: Steward[];
  budget?: DomainBudget;
  gates?: GateConfig[];
  /**
   * Optional per-domain priority engine configuration. See
   * specs/patterns/PRIORITY-ENGINE-SPEC.md §2. When absent, the engine
   * applies the spec-defined default weight profile and circuit-breaker.
   */
  priorityConfig?: DomainPriorityConfig;
}

export interface Steward {
  id: string;
  name: string;
  email?: string;
  role: "primary" | "secondary";
}

export interface DomainBudget {
  monthlyLimitUsd: number;
  currentSpendUsd: number;
  alertThreshold: number; // 0.0 to 1.0
  /**
   * When `currentSpendUsd` was last refreshed. Optional; when present,
   * downstream consumers (e.g. the priority engine explainer) can
   * annotate outputs as stale once the reading exceeds their freshness
   * threshold. See DOMAIN-SPEC §3.
   */
  lastUpdatedAt?: Timestamp;
}

export interface GateConfig {
  /** What type of work item requires this gate. */
  workItemType: string;
  /** Which enforcement tiers apply. */
  enforcement: ("mechanical" | "agent_review" | "human_gate")[];
  /** Who approves at the human gate tier. */
  approvers?: string[];
}

export interface DomainMembership {
  agentId: AgentId;
  domain: DomainId;
  role: "participant" | "observer";
  joinedAt: number;
}
