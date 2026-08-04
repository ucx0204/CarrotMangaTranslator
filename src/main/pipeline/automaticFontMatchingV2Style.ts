import type { FontMatchingDecisionResultV2 } from "./fontMatchingDecisionV2";
import type { FontMatchingWorkStateV2 } from "./fontMatchingDecisionV2Types";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import { resolveAutomaticFontEmphasisStyle } from "./automaticFontMatchingV2Emphasis";

/**
 * Family selection and emphasis treatment are intentionally independent.
 * This only decorates an automatic decision, so manual locks remain exact.
 */
export function applyAutomaticPixelStyle({
  pixelInference,
  result,
  workState,
}: {
  pixelInference: VerifiedAutomaticFontPixelInferenceV2 | null;
  result: FontMatchingDecisionResultV2;
  workState: FontMatchingWorkStateV2 | undefined;
}): FontMatchingDecisionResultV2 {
  if (
    !pixelInference ||
    !result.selectedStyle ||
    result.decision.mode !== "apply" ||
    result.decision.resolvedBy !== "v2_automatic"
  ) {
    return result;
  }
  const emphasis = resolveAutomaticFontEmphasisStyle({
    sourceStyle: pixelInference.sourceStyle,
    treatment: pixelInference.treatment,
    pageBaselineWeight: workState?.pageBalloonWeightBaseline,
    pageBaselineSampleCount: workState?.pageBalloonWeightBaselineSampleCount,
  });
  return {
    ...result,
    selectedStyle: { ...result.selectedStyle, ...emphasis.style },
  };
}
