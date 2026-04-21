/**
 * No-op implementation of the PriorityLearner interface.
 *
 * This is the default learner installed in the reference engine. It records
 * nothing, suggests no weight adjustments. Swap in a real learner (e.g.,
 * one that tracks outcomes and updates weights over time) to enable
 * compound learning; the engine does not change shape.
 */

import type {
  PriorityLearner,
  WorkItemId,
  QualitySignal,
  DomainId,
  Duration,
  WeightDelta,
} from "@loom-loyalty/meridian-types";

export class NoOpLearner implements PriorityLearner {
  onDecision(_workItemId: WorkItemId, _scoreAtSelection: number): void {
    // intentionally empty
  }

  onOutcome(_workItemId: WorkItemId, _quality: QualitySignal): void {
    // intentionally empty
  }

  suggestWeightAdjustment(_domain: DomainId, _window: Duration): WeightDelta {
    return {};
  }
}
