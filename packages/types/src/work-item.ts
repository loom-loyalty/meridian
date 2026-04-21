/**
 * Work item schema types.
 * Every unit of work carries two cost estimates in real dollars.
 */

import type { DomainId, WorkItemId, AgentId, Timestamp } from "./primitives.js";

export type WorkItemType = "initiative" | "epic" | "story" | "task";
export type WorkItemSource = "human" | "agent" | "feedback";
export type WorkItemStatus =
  | "proposed"
  | "researching"
  | "ready"
  | "in_progress"
  | "in_review"
  | "approved"
  | "deploying"
  | "validating"
  | "done"
  | "cancelled";

export interface WorkItem {
  id: WorkItemId;
  type: WorkItemType;
  title: string;
  description?: string;

  /** Which domain(s) this work belongs to. */
  domains: DomainId[];

  /** Who or what created this work item. */
  source: WorkItemSource;
  sourceAgentId?: AgentId;

  /** What feedback, insight, or initiative spawned this. */
  lineage?: WorkItemId;

  /** Real dollar cost estimates. */
  costToBuild: CostEstimate;
  costOfNotBuilding: CostEstimate;

  /** How confident is the system in the cost estimates. */
  confidence: number; // 0.0 to 1.0

  /** Current status. */
  status: WorkItemStatus;

  /** Priority score computed by the priority engine. */
  priorityScore?: number;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CostEstimate {
  amountUsd: number;
  breakdown?: {
    tokens?: number;
    compute?: number;
    humanHours?: number;
    revenueImpact?: number;
    riskExposure?: number;
    debtAccumulation?: number;
  };
  basis?: string; // human-readable explanation of how this was estimated
}
