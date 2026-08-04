import type {
  FontStyleSelectionV2,
  IntentionalTypographyOverrideV2,
  RoleFontPaletteV2,
  TypographyAnchorV2,
} from "../../shared/fontMatchingProfileTypes";
import {
  addDecisionRejection,
  evaluateCandidate,
  firstEligibleCandidate,
  rankedEligibleCandidates,
  rejectEligibleOutsideSet,
  type DecisionState,
} from "./fontMatchingDecisionV2Candidates";

export type ProfileResolution = {
  selection: FontStyleSelectionV2 | null;
  constrained: boolean;
  reasonCodes: string[];
};

const BODY_ANCHOR_KEYS = {
  dialogue: "dialogueAnchor",
  narration: "narrationAnchor",
  thought: "thoughtAnchor",
} as const;

const MINIMUM_PROFILE_EVIDENCE_COUNT = 1;
const MINIMUM_PALETTE_EVIDENCE_COUNT = 1;

export function resolveProfileSelection(
  state: DecisionState,
): ProfileResolution {
  const { profile } = state.input;
  if (!profile) return noProfileResolution();

  const anchorKey =
    BODY_ANCHOR_KEYS[state.input.role.primary as keyof typeof BODY_ANCHOR_KEYS];
  const anchor = anchorKey ? profile[anchorKey] : null;
  if (anchor) {
    if (state.input.workState?.automaticStrategy) {
      return {
        selection: null,
        constrained: false,
        reasonCodes: ["runtime_visual_evidence_precedes_body_anchor"],
      };
    }
    const failure = resolveAnchorEvidenceFailure(state, anchor);
    return failure
      ? constrainedFailure(failure)
      : resolveAnchorSelection(state, anchor);
  }

  const palette = profile.rolePalettes.find(
    (entry) => entry.role === state.input.role.primary,
  );
  if (palette) {
    if (state.input.workState?.automaticStrategy === "local_visual_first") {
      return {
        selection: null,
        constrained: false,
        reasonCodes: ["runtime_visual_evidence_precedes_role_palette"],
      };
    }
    const failure = resolvePaletteEvidenceFailure(state, palette);
    return failure
      ? constrainedFailure(failure)
      : resolvePaletteSelection(state, palette);
  }
  return resolveOverrideWithoutBaseline(state);
}

function resolveProfileEvidenceFailure(state: DecisionState): string | null {
  const profile = state.input.profile;
  if (!profile) return "profile_missing";
  const threshold = state.input.calibration.minimumRoleConfidence;
  if (state.input.role.confidence < threshold) {
    return "profile_role_confidence_below_threshold";
  }
  if (profile.confidence < threshold) {
    return "profile_confidence_below_threshold";
  }
  if (profile.evidenceCount < MINIMUM_PROFILE_EVIDENCE_COUNT) {
    return "profile_evidence_insufficient";
  }
  return null;
}

function resolveAnchorEvidenceFailure(
  state: DecisionState,
  anchor: TypographyAnchorV2,
): string | null {
  const profileFailure = resolveProfileEvidenceFailure(state);
  if (profileFailure) return profileFailure;
  if (anchor.confidence < state.input.calibration.minimumRoleConfidence) {
    return "anchor_confidence_below_threshold";
  }
  if (anchor.evidenceCount < anchor.replacementPolicy.minimumEvidenceCount) {
    return "anchor_evidence_insufficient";
  }
  return null;
}

function resolvePaletteEvidenceFailure(
  state: DecisionState,
  palette: RoleFontPaletteV2,
): string | null {
  const profileFailure = resolveProfileEvidenceFailure(state);
  if (profileFailure) return profileFailure;
  if (palette.confidence < state.input.calibration.minimumRoleConfidence) {
    return "palette_confidence_below_threshold";
  }
  if (palette.evidenceCount < MINIMUM_PALETTE_EVIDENCE_COUNT) {
    return "palette_evidence_insufficient";
  }
  return null;
}

function resolveAnchorSelection(
  state: DecisionState,
  anchor: TypographyAnchorV2,
): ProfileResolution {
  const override = resolveIntentionalOverride(state);
  const basePolicyIds = new Set(anchor.allowedFontIds);
  if (override) basePolicyIds.add(override.selection.fontId);
  rejectEligibleOutsideSet(state, basePolicyIds, "outside_anchor_set");
  const baseline = resolveAnchorBaseline(state, anchor);
  const overrideSelection = override
    ? resolveOverrideSelection(
        state,
        override,
        baseline,
        anchor.replacementPolicy.minimumScoreMargin,
      )
    : null;
  if (overrideSelection) {
    return selectedProfileResolution(overrideSelection, [
      "intentional_override_margin_passed",
      "anchor_hysteresis",
    ]);
  }
  if (baseline) {
    return selectedProfileResolution(baseline, ["body_anchor_hysteresis"]);
  }
  return constrainedFailure("body_anchor_unavailable");
}

function resolvePaletteSelection(
  state: DecisionState,
  palette: RoleFontPaletteV2,
): ProfileResolution {
  const allowed = resolvePaletteAllowedSet(state, palette);
  rejectEligibleOutsideSet(
    state,
    new Set(palette.allowedFontIds),
    "outside_role_palette",
  );
  const baseline = resolvePaletteBaseline(state, palette, allowed);
  const override = resolveAllowedPaletteOverride(state, allowed);
  const overrideSelection = override
    ? resolveOverrideSelection(
        state,
        override,
        baseline,
        state.input.calibration.intentionalOverrideMinimumScoreMargin,
      )
    : null;
  if (overrideSelection) {
    return selectedProfileResolution(overrideSelection, [
      "intentional_override_margin_passed",
      "role_palette",
    ]);
  }
  if (baseline) {
    return selectedProfileResolution(baseline, [
      "role_palette",
      "palette_distinct_limit_enforced",
    ]);
  }
  return constrainedFailure("role_palette_unavailable");
}

function resolveAllowedPaletteOverride(
  state: DecisionState,
  allowed: ReadonlySet<string>,
): IntentionalTypographyOverrideV2 | null {
  const override = resolveIntentionalOverride(state);
  if (!override || allowed.has(override.selection.fontId)) return override;
  addDecisionRejection(state, override.selection.fontId, "policy", [
    "outside_role_palette",
  ]);
  return null;
}

function resolveOverrideWithoutBaseline(
  state: DecisionState,
): ProfileResolution {
  const override = resolveIntentionalOverride(state);
  if (override) {
    addDecisionRejection(state, override.selection.fontId, "policy", [
      "intentional_override_score_missing",
    ]);
    return {
      selection: null,
      constrained: false,
      reasonCodes: ["intentional_override_requires_profile_baseline"],
    };
  }
  return {
    selection: null,
    constrained: false,
    reasonCodes: ["no_role_policy"],
  };
}

function resolveOverrideSelection(
  state: DecisionState,
  override: IntentionalTypographyOverrideV2,
  baseline: FontStyleSelectionV2 | null,
  requiredMargin: number | null,
): FontStyleSelectionV2 | null {
  const target = evaluateCandidate(state, override.selection.fontId);
  if (target.hardRejectReasons.length > 0) {
    addDecisionRejection(state, target.fontId, "policy", [
      "profile_target_unavailable",
    ]);
    return null;
  }
  if (!overrideConfidencePasses(state, override)) {
    addDecisionRejection(state, target.fontId, "policy", [
      "intentional_override_low_confidence",
    ]);
    return null;
  }
  if (!baseline || requiredMargin === null) {
    addDecisionRejection(state, target.fontId, "policy", [
      "intentional_override_score_missing",
    ]);
    return null;
  }
  if (baseline.fontId === target.fontId) return override.selection;
  return overrideMarginPasses(state, baseline, override, requiredMargin)
    ? override.selection
    : null;
}

function overrideMarginPasses(
  state: DecisionState,
  baseline: FontStyleSelectionV2,
  override: IntentionalTypographyOverrideV2,
  requiredMargin: number,
): boolean {
  const target = evaluateCandidate(state, override.selection.fontId);
  const baselineScore = evaluateCandidate(
    state,
    baseline.fontId,
  ).effectiveScore;
  if (baselineScore === null || target.effectiveScore === null) {
    addDecisionRejection(state, target.fontId, "policy", [
      "intentional_override_score_missing",
    ]);
    return false;
  }
  if (target.effectiveScore - baselineScore >= requiredMargin) return true;
  addDecisionRejection(state, target.fontId, "policy", [
    "intentional_override_margin_not_met",
  ]);
  return false;
}

function overrideConfidencePasses(
  state: DecisionState,
  override: IntentionalTypographyOverrideV2,
): boolean {
  return (
    override.confidence >=
    state.input.calibration.minimumIntentionalOverrideConfidence
  );
}

function resolveAnchorBaseline(
  state: DecisionState,
  anchor: TypographyAnchorV2,
): FontStyleSelectionV2 | null {
  const primary = evaluateCandidate(state, anchor.primaryFontId);
  if (primary.hardRejectReasons.length === 0)
    return { fontId: anchor.primaryFontId };

  const ranked = rankedEligibleCandidates(state).find((candidate) =>
    anchor.allowedFontIds.includes(candidate.fontId),
  );
  const fallback =
    ranked ?? firstEligibleCandidate(state, anchor.allowedFontIds);
  if (fallback) return { fontId: fallback.fontId };
  addDecisionRejection(state, anchor.primaryFontId, "policy", [
    "profile_target_unavailable",
  ]);
  return null;
}

function resolvePaletteBaseline(
  state: DecisionState,
  palette: RoleFontPaletteV2,
  allowed: ReadonlySet<string>,
): FontStyleSelectionV2 | null {
  const clusterSelection = resolveClusterSelection(state, allowed);
  if (clusterSelection) return clusterSelection;
  const ranked = rankedEligibleCandidates(state).find((candidate) =>
    allowed.has(candidate.fontId),
  );
  if (ranked) return { fontId: ranked.fontId };
  const fallback = firstEligibleCandidate(state, [...allowed]);
  if (fallback) return { fontId: fallback.fontId };
  rejectUnavailablePalette(state, palette);
  return null;
}

function resolveClusterSelection(
  state: DecisionState,
  allowed: ReadonlySet<string>,
): FontStyleSelectionV2 | null {
  const clusterFontId = state.input.workState?.visualClusterFontId;
  if (!clusterFontId || !allowed.has(clusterFontId)) return null;
  const cluster = evaluateCandidate(state, clusterFontId);
  return cluster.hardRejectReasons.length === 0
    ? { fontId: clusterFontId }
    : null;
}

function resolvePaletteAllowedSet(
  state: DecisionState,
  palette: RoleFontPaletteV2,
): Set<string> {
  const paletteSet = new Set(palette.allowedFontIds);
  const used = uniqueSorted(
    state.input.workState?.rolePaletteUsedFontIds ?? [],
  ).filter((fontId) => paletteSet.has(fontId));
  if (used.length < palette.maxDistinctFonts) return paletteSet;
  rejectFontsBeyondDistinctLimit(state, palette, new Set(used));
  return new Set(used);
}

function rejectFontsBeyondDistinctLimit(
  state: DecisionState,
  palette: RoleFontPaletteV2,
  allowed: ReadonlySet<string>,
): void {
  for (const fontId of palette.allowedFontIds) {
    if (!allowed.has(fontId)) {
      addDecisionRejection(state, fontId, "policy", [
        "palette_distinct_limit_reached",
      ]);
    }
  }
}

function rejectUnavailablePalette(
  state: DecisionState,
  palette: RoleFontPaletteV2,
): void {
  for (const fontId of palette.allowedFontIds) {
    addDecisionRejection(state, fontId, "policy", [
      "profile_target_unavailable",
    ]);
  }
}

function resolveIntentionalOverride(
  state: DecisionState,
): IntentionalTypographyOverrideV2 | null {
  const matching = state.input.profile?.intentionalOverrides.filter(
    (entry) => entry.role === state.input.role.primary,
  );
  const block = matching?.find((entry) => matchesBlockScope(state, entry));
  if (block) return block;
  const clusterId = state.input.workState?.visualClusterId;
  return (
    matching?.find(
      (entry) =>
        entry.scope.type === "visual_cluster" &&
        entry.scope.visualClusterId === clusterId,
    ) ?? null
  );
}

function matchesBlockScope(
  state: DecisionState,
  override: IntentionalTypographyOverrideV2,
): boolean {
  const { scope } = override;
  return (
    scope.type === "block" &&
    scope.chapterId === state.input.chapterId &&
    scope.pageId === state.input.pageId &&
    scope.blockId === state.input.blockId
  );
}

function noProfileResolution(): ProfileResolution {
  return { selection: null, constrained: false, reasonCodes: ["no_profile"] };
}

function selectedProfileResolution(
  selection: FontStyleSelectionV2,
  reasonCodes: string[],
): ProfileResolution {
  return { selection, constrained: true, reasonCodes };
}

function constrainedFailure(reason: string): ProfileResolution {
  return { selection: null, constrained: true, reasonCodes: [reason] };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
