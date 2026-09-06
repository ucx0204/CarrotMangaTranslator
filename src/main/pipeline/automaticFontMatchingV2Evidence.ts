import { resolveFontPaletteEvidence } from "./fontMatchingPaletteEvidence";
import type {
  FontMatchRolePredictionV2,
  RankedFontCandidateV2,
} from "../../shared/fontMatchingProfileTypes";
import type { AutomaticFontCandidate } from "../../shared/fontMatchingTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import type { UiLocale } from "../../shared/uiLocales";
import { assessAutomaticFontTranslations } from "./automaticFontMatchingV2CandidateAssessment";
import { resolveFontMatchingV2CatalogVersion } from "./automaticFontMatchingV2Catalog";
import { applyAutomaticFontChapterBodyPrior } from "./automaticFontMatchingV2ChapterPrior";
import { applyAutomaticFontPageConsistency } from "./automaticFontMatchingV2PageConsistency";
import type { FontMatchingWorkStateV2 } from "./fontMatchingDecisionV2Types";
import type { VerifiedAutomaticFontPixelInferenceV2 } from "./fontMatchingPagePixelInferenceTypes";
import type { FontMatchingRuntimePolicy } from "./fontMatchingRuntimePolicyContract";
import { applySelectionRoleFamilyConflictConfidenceCap } from "./fontMatchingSelectionCalibration";
import { applyCrossScriptProxyCandidateRanking } from "./automaticFontMatchingV2CrossScriptProxy";
import {
  applyFontExpressionRanking,
  resolveAutomaticFontExpression,
} from "./automaticFontMatchingExpression";

export function prepareAutomaticFontEvidence({
  block,
  candidates,
  locale,
  pixelInference,
  role,
  runtimePolicy,
  workState,
}: {
  block: TranslationBlock;
  candidates: readonly AutomaticFontCandidate[];
  locale: UiLocale;
  pixelInference: VerifiedAutomaticFontPixelInferenceV2 | null;
  role: FontMatchRolePredictionV2;
  runtimePolicy: FontMatchingRuntimePolicy | null;
  workState: FontMatchingWorkStateV2 | undefined;
}): {
  catalogVersion: string;
  rankedCandidates: readonly RankedFontCandidateV2[];
  translationAssessments: ReturnType<typeof assessAutomaticFontTranslations>;
} {
  const localCandidates = resolveFontPaletteEvidence({
    candidates,
    locale,
    role,
    block,
    pixelInference,
  });
  const crossScriptCandidates = applyCrossScriptProxyCandidateRanking(
    localCandidates,
    candidates,
    pixelInference,
  );
  const common = {
    catalogVersion: resolveFontMatchingV2CatalogVersion(candidates),
    translationAssessments: assessAutomaticFontTranslations(
      candidates,
      block.translatedText,
    ),
  };
  if (crossScriptCandidates) {
    const style = resolveAutomaticFontExpression(pixelInference, candidates);
    return {
      ...common,
      rankedCandidates: applyFontExpressionRanking(
        crossScriptCandidates,
        style,
      ),
    };
  }
  const priorAdjustedCandidates =
    workState?.pageBalloonConsistencyMode === "local_visual_variant"
      ? localCandidates
      : applyAutomaticFontChapterBodyPrior(
          localCandidates,
          workState,
          runtimePolicy ?? undefined,
        );
  const roleAdjustedCandidates = pixelInference
    ? applySelectionRoleFamilyConflictConfidenceCap(
        priorAdjustedCandidates,
        pixelInference.rolePrediction.primary,
        role.primary,
        pixelInference.selectionCalibration.globalRiskLowerConfidenceBound,
      )
    : priorAdjustedCandidates;
  return {
    ...common,
    rankedCandidates: applyAutomaticFontPageConsistency(
      roleAdjustedCandidates,
      workState,
    ),
  };
}
