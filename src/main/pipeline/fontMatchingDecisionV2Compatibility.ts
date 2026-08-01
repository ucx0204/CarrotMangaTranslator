import type { FontMatchAbstainReason } from "../../shared/fontMatchingProfileTypes";
import type { FontMatchingDecisionInputV2 } from "./fontMatchingDecisionV2Types";

/**
 * A persisted work profile is an atomic snapshot. None of its policies or
 * locks may be consumed when it was produced for another work, candidate
 * catalog, model, or renderer.
 */
export function resolveProfileCompatibilityFailure(
  input: FontMatchingDecisionInputV2,
): FontMatchAbstainReason | null {
  const { profile, localEvidence } = input;
  if (!profile) return null;
  if (profile.workId !== input.workId) return "profile_conflict";
  const incompatible =
    profile.catalogVersion !== localEvidence.catalogVersion ||
    profile.modelVersion !== localEvidence.modelVersion ||
    profile.rendererHash !== localEvidence.rendererHash;
  return incompatible ? "catalog_mismatch" : null;
}

export function resolveCompatibleProfile(
  input: FontMatchingDecisionInputV2,
): FontMatchingDecisionInputV2["profile"] {
  return resolveProfileCompatibilityFailure(input) === null
    ? input.profile
    : null;
}
