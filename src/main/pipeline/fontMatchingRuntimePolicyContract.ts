export type FontMatchingRuntimePolicy = Readonly<{
  automaticMutation: Readonly<{
    minimumAutomaticConfidence: number;
    minimumRoleConfidence: number;
    minimumIntentionalOverrideConfidence: number;
    intentionalOverrideMinimumScoreMargin: number;
  }>;
  chapterPrior: Readonly<{
    maximumScoreContribution: number;
    minimumAnchorEvidenceCount: number;
    localOverrideMinimumScoreMargin: number;
  }>;
}>;

export function parseFontMatchingRuntimePolicy(
  policy: Record<string, unknown> | null,
): FontMatchingRuntimePolicy | null {
  if (
    !policy ||
    !sameKeys(policy, [
      "automatic_mutation",
      "chapter_prior",
      "policy_sha256",
    ]) ||
    !isSha256(policy.policy_sha256)
  ) {
    return null;
  }
  const automatic = recordAt(policy, "automatic_mutation");
  const prior = recordAt(policy, "chapter_prior");
  if (!validAutomaticPolicy(automatic) || !validChapterPrior(prior)) {
    return null;
  }
  return {
    automaticMutation: {
      minimumAutomaticConfidence: Number(
        automatic.minimum_calibrated_confidence,
      ),
      minimumRoleConfidence: Number(automatic.minimum_role_confidence),
      minimumIntentionalOverrideConfidence: Number(
        automatic.minimum_intentional_override_confidence,
      ),
      intentionalOverrideMinimumScoreMargin: Number(
        automatic.intentional_override_minimum_score_margin,
      ),
    },
    chapterPrior: {
      maximumScoreContribution: Number(prior.maximum_score_contribution),
      minimumAnchorEvidenceCount: Number(prior.minimum_anchor_evidence_count),
      localOverrideMinimumScoreMargin: Number(
        prior.local_override_minimum_score_margin,
      ),
    },
  };
}

function validAutomaticPolicy(
  automatic: Record<string, unknown> | null,
): automatic is Record<string, unknown> {
  return Boolean(
    automatic &&
    sameKeys(automatic, [
      "intentional_override_minimum_score_margin",
      "minimum_calibrated_confidence",
      "minimum_intentional_override_confidence",
      "minimum_role_confidence",
      "require_none_acceptable_false",
      "require_runtime_artifact_ready",
      "require_translation_glyph_coverage",
    ]) &&
    automatic.require_none_acceptable_false === true &&
    automatic.require_runtime_artifact_ready === true &&
    automatic.require_translation_glyph_coverage === true &&
    isProbability(automatic.minimum_calibrated_confidence) &&
    isProbability(automatic.minimum_role_confidence) &&
    isProbability(automatic.minimum_intentional_override_confidence) &&
    isProbability(automatic.intentional_override_minimum_score_margin),
  );
}

function validChapterPrior(
  prior: Record<string, unknown> | null,
): prior is Record<string, unknown> {
  return Boolean(
    prior &&
    sameKeys(prior, [
      "local_override_minimum_score_margin",
      "maximum_score_contribution",
      "minimum_anchor_evidence_count",
      "mode",
      "real_local_change_overrides_prior",
      "scope",
    ]) &&
    prior.mode === "weak_prior_never_hard_constraint" &&
    prior.scope === "chapter" &&
    prior.real_local_change_overrides_prior === true &&
    isProbability(prior.maximum_score_contribution) &&
    Number(prior.maximum_score_contribution) <= 0.1 &&
    Number.isInteger(prior.minimum_anchor_evidence_count) &&
    Number(prior.minimum_anchor_evidence_count) >= 2 &&
    isProbability(prior.local_override_minimum_score_margin),
  );
}

function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : null;
}

function sameKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((entry, index) => entry === sortedExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
