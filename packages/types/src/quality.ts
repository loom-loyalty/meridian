/**
 * Quality enforcement types.
 * Structured quality signals, graduated enforcement tiers,
 * and machine-readable competing context.
 *
 * @experimental - all types in this module
 */

import type { AgentId, WorkItemId } from "./primitives.js";

export type EnforcementTier = "mechanical" | "agent_review" | "human_gate";

export interface QualityCheck {
  name: string;
  result: "pass" | "fail" | "warn" | "skip";
  message?: string;
  file?: string;
  line?: number;
  fix?: string;
  autoFixable: boolean;
}

export interface QualitySignal {
  result: "pass" | "fail" | "warn";
  score?: number;
  category:
    | "architectural"
    | "behavioral"
    | "performance"
    | "security"
    | "documentation"
    | "testing"
    | "entropy"
    | "custom";
  checks?: QualityCheck[];
  workItemId?: WorkItemId;
  enforcementTier: EnforcementTier;
}

export interface CompetingContext {
  sourceAgentId: AgentId;
  contestedWorkItemId: WorkItemId;
  concern:
    | "dependency_risk"
    | "sla_risk"
    | "cost_risk"
    | "data_risk"
    | "performance_risk"
    | "security_risk"
    | "architectural_risk"
    | "custom";
  impact: {
    affectedConsumers?: number;
    revenueAtRiskUsd?: number;
    blastRadius: "isolated" | "module" | "service" | "domain" | "system";
    breakingDependencies?: string[];
  };
  argument: string;
  suggestedAlternative?: string;
  confidence: number;
}
