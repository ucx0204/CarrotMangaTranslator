import type { FontMatchingRuntimePolicy } from "./fontMatchingRuntimePolicyContract";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";

const FAIL_CLOSED_CALIBRATION: FontMatchingRuntimePolicy["automaticMutation"] =
  {
    minimumAutomaticConfidence: 1,
    minimumRoleConfidence: 1,
    minimumIntentionalOverrideConfidence: 1,
    intentionalOverrideMinimumScoreMargin: 1,
  };

export function resolveAutomaticDecisionCalibration(
  runtimePolicy: FontMatchingRuntimePolicy | null,
  pixelInference: VerifiedAutomaticFontPixelInferenceV2 | null,
): FontMatchingRuntimePolicy["automaticMutation"] {
  const base = runtimePolicy?.automaticMutation ?? FAIL_CLOSED_CALIBRATION;
  if (!pixelInference) return { ...base };

  const bestAvailableSelection =
    !pixelInference.selectionCalibration.applied &&
    pixelInference.localEvidence.rankedCandidates.some(
      (candidate) => candidate.renderStatus === "rendered",
    );

  // The supervised selector has already applied its sealed cohort operating
  // point. Its confidence is a cohort risk lower bound, not the legacy raw
  // ONNX confidence scale. Automatic mode still has a job when calibration
  // declines: choose the best renderable pixel candidate instead of silently
  // retaining the formatting font.
  return {
    ...base,
    minimumAutomaticConfidence: pixelInference.selectionCalibration.applied
      ? pixelInference.selectionCalibration.globalRiskLowerConfidenceBound
      : bestAvailableSelection
        ? 0
        : 1,
    minimumRoleConfidence: bestAvailableSelection
      ? 0
      : base.minimumRoleConfidence,
  };
}
