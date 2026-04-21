/**
 * Default weight profiles for the reference priority engine.
 *
 * These are non-normative. Adopters can use them as-is, override them per
 * domain via `DomainPriorityConfig.weightProfileId`, or ignore them
 * entirely in a custom engine. See specs/patterns/PRIORITY-ENGINE-SPEC.md §8.
 */

import type { WeightProfile } from "@loom-loyalty/meridian-types";

export const DEFAULT_WEIGHT_PROFILE: Required<Omit<WeightProfile, "id">> & {
  id: "default";
} = {
  id: "default",
  costOfNotBuildingWeight: 1.0,
  timeCriticalityWeight: 1.0,
  impactWeight: 1.0,
  confidenceMultiplier: 1.0,
  usdPerAffectedConsumer: 1.0,
  usdPerDayWeight: 1.0,
  regressionMultiplierCap: 2.0,
  timeCriticalityCap: 2.0,
};

/**
 * Infra-tuned profile. Loom's infrastructure domain weights cost-of-not-building
 * higher (a DB that falls over tomorrow is a bigger fire than one that doesn't)
 * and impact lower (infra fires typically affect a known set of services rather
 * than unbounded consumer counts).
 */
export const INFRA_WEIGHT_PROFILE: Required<Omit<WeightProfile, "id">> & {
  id: "infra";
} = {
  id: "infra",
  costOfNotBuildingWeight: 1.5,
  timeCriticalityWeight: 1.2,
  impactWeight: 0.8,
  confidenceMultiplier: 1.0,
  usdPerAffectedConsumer: 1.0,
  usdPerDayWeight: 1.0,
  regressionMultiplierCap: 2.0,
  timeCriticalityCap: 2.0,
};

/**
 * Product-tuned profile. Product insights are fuzzier than infra readings;
 * confidence weights harder so that a high-confidence drop outranks a
 * low-confidence revenue-at-risk claim.
 */
export const PRODUCT_WEIGHT_PROFILE: Required<Omit<WeightProfile, "id">> & {
  id: "product";
} = {
  id: "product",
  costOfNotBuildingWeight: 0.8,
  timeCriticalityWeight: 1.0,
  impactWeight: 1.0,
  confidenceMultiplier: 1.3,
  usdPerAffectedConsumer: 5.0,
  usdPerDayWeight: 1.0,
  regressionMultiplierCap: 2.0,
  timeCriticalityCap: 2.0,
};

/**
 * Look up a weight profile by id. Unknown ids fall back to the default profile.
 * Implementations that want to disallow unknown ids can reject at the caller.
 */
export function resolveWeightProfile(
  id: string | undefined,
):
  | typeof DEFAULT_WEIGHT_PROFILE
  | typeof INFRA_WEIGHT_PROFILE
  | typeof PRODUCT_WEIGHT_PROFILE {
  switch (id) {
    case "infra":
      return INFRA_WEIGHT_PROFILE;
    case "product":
      return PRODUCT_WEIGHT_PROFILE;
    case "default":
    case undefined:
      return DEFAULT_WEIGHT_PROFILE;
    default:
      return DEFAULT_WEIGHT_PROFILE;
  }
}
