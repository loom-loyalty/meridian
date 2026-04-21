/**
 * Feedback contract types.
 * Defines the structured signals every Meridian component emits.
 */

import type { AgentId, DomainId, Timestamp, Cost } from "./primitives.js";
import type { QualitySignal, CompetingContext } from "./quality.js";

/** Feedback tiers determine what the system requires from each component. */
export type FeedbackTier = "required" | "expected" | "optional";

/** Heartbeat status for required feedback. */
export type AgentStatus =
  | "running"
  | "degraded"
  | "overloaded"
  | "initializing"
  | "draining"
  | "offline";

/** Required: heartbeat signal. */
export interface HeartbeatFeedback {
  tier: "required";
  type: "heartbeat";
  agentId: AgentId;
  domain: DomainId;
  status: AgentStatus;
  timestamp: Timestamp;
}

/** Required: cost attribution signal. */
export interface CostFeedback {
  tier: "required";
  type: "cost";
  agentId: AgentId;
  domain: DomainId;
  cost: Cost;
  breakdown?: {
    compute?: number;
    tokensInput?: number;
    tokensOutput?: number;
    toolCalls?: number;
    storage?: number;
    network?: number;
  };
  timestamp: Timestamp;
}

/** Required: structured error signal. */
export interface ErrorFeedback {
  tier: "required";
  type: "error";
  agentId: AgentId;
  domain: DomainId;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  message: string;
  frequency: "first" | "recurring" | "escalating";
  blastRadius: "user" | "customer" | "all_customers" | "internal";
  recovered: boolean;
  timestamp: Timestamp;
}

/** Required: dependency declaration. */
export interface DependencyFeedback {
  tier: "required";
  type: "dependencies";
  agentId: AgentId;
  domain: DomainId;
  dependsOn: string[];
  dependedOnBy: string[];
  context?: Record<string, unknown>;
  timestamp: Timestamp;
}

/** Expected: metric with baseline. */
export interface MetricFeedback {
  tier: "expected";
  type: "metric";
  agentId: AgentId;
  domain: DomainId;
  name: string;
  value: number;
  baseline?: number;
  unit?: string;
  timestamp: Timestamp;
}

/**
 * Expected: insight with confidence.
 *
 * The insight text may be supplied as a single `summary` (narrative-style,
 * matches `MERIDIAN-IN-PRACTICE.md` Ch 1) or as the earlier `message` +
 * `category` pair. At least one form SHOULD be present; all three are
 * optional to preserve additive compatibility with prior v1.0-draft
 * implementations.
 */
export interface InsightFeedback {
  tier: "expected";
  type: "insight";
  agentId: AgentId;
  domain: DomainId;
  confidence: number;
  /** Single-field narrative summary of the insight. Preferred. */
  summary?: string;
  /** Legacy: structured message paired with {@link category}. */
  message?: string;
  /** Legacy: classification tag paired with {@link message}. */
  category?: string;
  evidence?: unknown;
  suggestedAction?: string;
  timestamp: Timestamp;
}

/** Expected: capacity and headroom. */
export interface CapacityFeedback {
  tier: "expected";
  type: "capacity";
  agentId: AgentId;
  domain: DomainId;
  current: number;
  max: number;
  unit: string;
  timestamp: Timestamp;
}

/** Expected: forecast / projection. */
export interface ForecastFeedback {
  tier: "expected";
  type: "forecast";
  agentId: AgentId;
  domain: DomainId;
  metric: string;
  projectedValue: number;
  projectedAt: Timestamp;
  confidence: number;
  message: string;
  timestamp: Timestamp;
}

/** Optional: quality signal. */
export interface QualityFeedback {
  tier: "optional";
  type: "quality";
  agentId: AgentId;
  domain: DomainId;
  signal: QualitySignal;
  timestamp: Timestamp;
}

/** Optional: competing context. */
export interface CompetingContextFeedback {
  tier: "optional";
  type: "competing_context";
  agentId: AgentId;
  domain: DomainId;
  context: CompetingContext;
  timestamp: Timestamp;
}

/** Union of all feedback signal types. */
export type FeedbackSignal =
  | HeartbeatFeedback
  | CostFeedback
  | ErrorFeedback
  | DependencyFeedback
  | MetricFeedback
  | InsightFeedback
  | CapacityFeedback
  | ForecastFeedback
  | QualityFeedback
  | CompetingContextFeedback;
