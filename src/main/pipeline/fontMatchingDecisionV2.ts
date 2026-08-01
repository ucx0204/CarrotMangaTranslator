import type {
  FontMatchAbstainReason,
  FontMatchDecisionV2,
  FontMatchingDecisionPrioritySource,
  FontStyleSelectionV2,
} from "../../shared/fontMatchingProfileTypes";
import {
  buildDecisionAudit,
  buildTopCandidateIds,
  recordDecisionTrace,
} from "./fontMatchingDecisionV2Audit";
import {
  addDecisionRejection,
  createDecisionState,
  evaluateCandidate,
  rankedEligibleCandidates,
  type CandidateEvaluation,
  type DecisionState,
} from "./fontMatchingDecisionV2Candidates";
import { resolveProfileSelection } from "./fontMatchingDecisionV2Profile";
import { resolveProfileCompatibilityFailure } from "./fontMatchingDecisionV2Compatibility";
import type {
  FontCandidatePolicyRejectReasonV2,
  FontMatchingDecisionInputV2,
  FontMatchingDecisionResultV2,
} from "./fontMatchingDecisionV2Types";

export type {
  BlockLocalFontEvidenceV2,
  FontCandidateDecisionAuditV2,
  FontCandidateHardRejectReasonV2,
  FontCandidatePolicyRejectReasonV2,
  FontCandidateRejectReasonV2,
  FontCandidateRejectionAuditV2,
  FontDecisionPriorityTraceV2,
  FontMatchingDecisionCalibrationV2,
  FontMatchingDecisionInputV2,
  FontMatchingDecisionResultV2,
  FontMatchingWorkStateV2,
  TranslationFontAssessmentV2,
} from "./fontMatchingDecisionV2Types";

/** Pure V2 policy: it performs no I/O, clock reads, mutation, or legacy fallback. */
export function resolveFontMatchingDecisionV2(
  input: FontMatchingDecisionInputV2,
): FontMatchingDecisionResultV2 {
  validateCalibration(input);
  const state = createDecisionState(input);
  const compatibilityFailure = resolveProfileCompatibilityFailure(input);
  if (compatibilityFailure) {
    recordDecisionTrace(state, "block_user_lock", "not_reached", null, [
      "profile_version_gate",
    ]);
    recordDecisionTrace(state, "work_role_user_lock", "not_reached", null, [
      "profile_version_gate",
    ]);
    recordDecisionTrace(state, "work_profile", "rejected", null, [
      compatibilityFailure,
    ]);
    recordDecisionTrace(state, "v2_automatic", "not_reached", null, [
      "profile_version_gate",
    ]);
    return finishAbstained(state, compatibilityFailure);
  }
  const blockResult = resolveLock(
    state,
    "block_user_lock",
    resolveBlockLock(input),
  );
  if (blockResult.selection) {
    return finishApplied(state, blockResult.selection, "block_user_lock");
  }

  const roleResult = resolveRoleLockWithConfidenceGate(state);
  if (roleResult.selection) {
    return finishApplied(state, roleResult.selection, "work_role_user_lock");
  }
  if (blockResult.unavailable || roleResult.unavailable) {
    recordDecisionTrace(state, "work_profile", "not_reached", null, [
      "configured_user_lock_unavailable",
    ]);
    recordDecisionTrace(state, "v2_automatic", "not_reached", null, [
      "configured_user_lock_unavailable",
    ]);
    return finishAbstained(state, "unrenderable_translation");
  }
  return resolveAfterLocks(state);
}

type LockResolution = {
  selection: FontStyleSelectionV2 | null;
  unavailable: boolean;
};

function resolveRoleLockWithConfidenceGate(
  state: DecisionState,
): LockResolution {
  if (
    state.input.role.confidence < state.input.calibration.minimumRoleConfidence
  ) {
    recordDecisionTrace(state, "work_role_user_lock", "skipped", null, [
      "role_confidence_below_threshold",
    ]);
    return { selection: null, unavailable: false };
  }
  return resolveLock(
    state,
    "work_role_user_lock",
    resolveRoleLock(state.input),
  );
}

function resolveAfterLocks(state: DecisionState): FontMatchingDecisionResultV2 {
  if (state.input.role.primary === "unknown_needs_review") {
    recordDecisionTrace(state, "work_profile", "skipped", null, [
      "role_unknown",
    ]);
    recordDecisionTrace(state, "v2_automatic", "rejected", null, [
      "role_unknown",
    ]);
    return finishAbstained(state, "role_unknown");
  }
  return resolveProfileOrAutomatic(state);
}

function resolveProfileOrAutomatic(
  state: DecisionState,
): FontMatchingDecisionResultV2 {
  const profile = resolveProfileSelection(state);
  if (profile.selection) {
    recordDecisionTrace(
      state,
      "work_profile",
      "selected",
      profile.selection.fontId,
      [...profile.reasonCodes],
    );
    return finishApplied(state, profile.selection, "work_profile");
  }
  recordDecisionTrace(
    state,
    "work_profile",
    profile.constrained ? "rejected" : "skipped",
    null,
    profile.reasonCodes,
  );
  if (!profile.constrained) return resolveAutomaticOrAbstain(state);

  recordDecisionTrace(state, "v2_automatic", "not_reached", null, [
    "profile_constraint_is_strict",
  ]);
  return finishAbstained(state, resolveProfileAbstainReason(state));
}

function resolveAutomaticOrAbstain(
  state: DecisionState,
): FontMatchingDecisionResultV2 {
  const eligible = rankedEligibleCandidates(state);
  const best = eligible[0];
  if (!best) {
    recordDecisionTrace(state, "v2_automatic", "rejected", null, [
      "no_translation_feasible_candidate",
    ]);
    return finishAbstained(state, "unrenderable_translation");
  }
  if (state.input.localEvidence.noneAcceptable) {
    rejectAutomaticCandidates(
      state,
      eligible,
      "model_reported_none_acceptable",
    );
    recordDecisionTrace(state, "v2_automatic", "rejected", null, [
      "model_reported_none_acceptable",
    ]);
    return finishAbstained(state, "no_acceptable_candidate");
  }
  if (!passesAutomaticConfidence(state, best)) {
    addDecisionRejection(state, best.fontId, "policy", [
      "automatic_confidence_below_threshold",
    ]);
    recordDecisionTrace(state, "v2_automatic", "rejected", best.fontId, [
      "automatic_confidence_below_threshold",
    ]);
    return finishAbstained(state, "low_confidence");
  }
  recordDecisionTrace(state, "v2_automatic", "selected", best.fontId, [
    "calibrated_threshold_passed",
  ]);
  return finishApplied(state, { fontId: best.fontId }, "v2_automatic");
}

function resolveLock(
  state: DecisionState,
  priority: "block_user_lock" | "work_role_user_lock",
  selection: FontStyleSelectionV2 | null,
): LockResolution {
  if (!selection) {
    recordDecisionTrace(state, priority, "skipped", null, ["not_configured"]);
    return { selection: null, unavailable: false };
  }
  const evaluation = evaluateCandidate(state, selection.fontId);
  if (evaluation.hardRejectReasons.length === 0) {
    recordDecisionTrace(state, priority, "selected", selection.fontId, [
      "user_lock_hard_gates_passed",
    ]);
    return { selection, unavailable: false };
  }
  addDecisionRejection(state, selection.fontId, "policy", [
    "lock_target_unavailable",
  ]);
  recordDecisionTrace(state, priority, "rejected", selection.fontId, [
    "lock_target_unavailable",
    ...evaluation.hardRejectReasons,
  ]);
  return { selection: null, unavailable: true };
}

function finishApplied(
  state: DecisionState,
  selection: FontStyleSelectionV2,
  resolvedBy: Exclude<
    FontMatchingDecisionPrioritySource,
    "user_default_or_top3"
  >,
): FontMatchingDecisionResultV2 {
  const decision: FontMatchDecisionV2 = {
    mode: "apply",
    selectedFontId: selection.fontId,
    topCandidateFontIds: buildTopCandidateIds(state, selection.fontId),
    noneAcceptable: false,
    abstainReason: null,
    resolvedBy,
  };
  return finish(state, decision, selection);
}

function finishAbstained(
  state: DecisionState,
  reason: FontMatchAbstainReason,
): FontMatchingDecisionResultV2 {
  const topCandidateFontIds = buildTopCandidateIds(state, null);
  recordDecisionTrace(state, "user_default_or_top3", "abstained", null, [
    reason,
  ]);
  const decision: FontMatchDecisionV2 = {
    mode: "abstain",
    selectedFontId: null,
    topCandidateFontIds,
    noneAcceptable: reason === "no_acceptable_candidate",
    abstainReason: reason,
    resolvedBy: "user_default_or_top3",
  };
  return finish(state, decision, null);
}

function finish(
  state: DecisionState,
  decision: FontMatchDecisionV2,
  selectedStyle: FontStyleSelectionV2 | null,
): FontMatchingDecisionResultV2 {
  return {
    decision,
    selectedStyle,
    audit: buildDecisionAudit(state, decision.resolvedBy),
  };
}

function passesAutomaticConfidence(
  state: DecisionState,
  best: CandidateEvaluation,
): boolean {
  const threshold = state.input.calibration.minimumAutomaticConfidence;
  return (
    state.input.localEvidence.calibratedConfidence >= threshold &&
    (best.calibratedCandidateConfidence ?? 0) >= threshold &&
    state.input.role.confidence >= state.input.calibration.minimumRoleConfidence
  );
}

function resolveProfileAbstainReason(
  state: DecisionState,
): FontMatchAbstainReason {
  return rankedEligibleCandidates(state).length === 0
    ? "unrenderable_translation"
    : "profile_conflict";
}

function rejectAutomaticCandidates(
  state: DecisionState,
  candidates: readonly CandidateEvaluation[],
  reason: FontCandidatePolicyRejectReasonV2,
): void {
  for (const candidate of candidates) {
    addDecisionRejection(state, candidate.fontId, "policy", [reason]);
  }
}

function resolveBlockLock(
  input: FontMatchingDecisionInputV2,
): FontStyleSelectionV2 | null {
  if (input.blockUserLock !== undefined) return input.blockUserLock;
  if (input.profile?.workId !== input.workId) return null;
  return (
    input.profile?.userLocks.find(
      (lock) =>
        lock.scope.type === "block" &&
        lock.scope.chapterId === input.chapterId &&
        lock.scope.pageId === input.pageId &&
        lock.scope.blockId === input.blockId,
    )?.selection ?? null
  );
}

function resolveRoleLock(
  input: FontMatchingDecisionInputV2,
): FontStyleSelectionV2 | null {
  if (input.workRoleUserLock !== undefined) return input.workRoleUserLock;
  if (input.profile?.workId !== input.workId) return null;
  return (
    input.profile?.userLocks.find(
      (lock) =>
        lock.scope.type === "role" && lock.scope.role === input.role.primary,
    )?.selection ?? null
  );
}

function validateCalibration(input: FontMatchingDecisionInputV2): void {
  for (const [key, value] of Object.entries(input.calibration)) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`${key} must be between zero and one`);
    }
  }
}
