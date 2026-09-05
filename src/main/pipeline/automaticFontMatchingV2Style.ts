import type { FontMatchingDecisionResultV2 } from "./fontMatchingDecisionV2";
import type { FontMatchingWorkStateV2 } from "./fontMatchingDecisionV2Types";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import { resolveAutomaticFontEmphasisStyle } from "./automaticFontMatchingV2Emphasis";
import { resolveCrossScriptProxySelectionStyle } from "./automaticFontMatchingV2CrossScriptProxy";
import { resolveAutomaticFontExpression } from "./automaticFontMatchingExpression";

/**
 * Family selection and emphasis treatment are intentionally independent.
 * This only decorates an automatic decision, so manual locks remain exact.
 */
export function applyAutomaticPixelStyle({
  candidates,
  pixelInference,
  result,
  workState,
}: {
  candidates: readonly AutomaticFontCandidate[];
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
  const expressionStyle = resolveAutomaticFontExpression(
    pixelInference,
    candidates,
  );
  if (expressionStyle?.fontId === result.selectedStyle.fontId) {
    return { ...result, selectedStyle: expressionStyle };
  }
  const crossScriptStyle = resolveCrossScriptProxySelectionStyle(
    pixelInference,
    candidates,
    result.selectedStyle.fontId,
  );
  if (crossScriptStyle) {
    return { ...result, selectedStyle: crossScriptStyle };
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
