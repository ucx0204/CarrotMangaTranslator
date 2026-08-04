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

  // The supervised selector has already applied its sealed cohort operating
  // point. Its confidence is a cohort risk lower bound, not the legacy raw
  // ONNX confidence scale, so comparing it against the old gate would reject
  // every otherwise accepted selection. Honor that learned bound once and
  // fail closed whenever the selector itself declined the sample.
  return {
    ...base,
    minimumAutomaticConfidence: pixelInference.selectionCalibration.applied
      ? pixelInference.selectionCalibration.globalRiskLowerConfidenceBound
      : 1,
  };
}
