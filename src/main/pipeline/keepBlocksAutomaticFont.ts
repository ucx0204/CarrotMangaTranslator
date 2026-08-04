import type { TranslationOptions } from "../appSettings";
import type { AutomaticFontPageCoordinatorV2 } from "./automaticFontMatchingV2PageCoordinator";
import type { FontMatchingPageInferenceResult } from "./fontMatchingPagePixelInferenceTypes";
import type { OverlayAutomaticFontOptions } from "./overlayItems";

export type KeepBlocksAutomaticFontOptions = Omit<
  OverlayAutomaticFontOptions,
  "pageCoordinator" | "pixelInference" | "runtimeArtifactStatus"
> &
  Readonly<{
    pageCoordinator?: AutomaticFontPageCoordinatorV2;
    pageInference?: FontMatchingPageInferenceResult;
  }>;

export function resolveKeepBlocksAutomaticFont(
  pageOptions: TranslationOptions,
  pageInference: FontMatchingPageInferenceResult,
  pageCoordinator?: AutomaticFontPageCoordinatorV2,
): KeepBlocksAutomaticFontOptions {
  return {
    enabled: pageOptions.autoFontMatching,
    targetLanguage: pageOptions.targetLanguage,
    workId: pageOptions.fontMatchingWorkId,
    chapterId: pageOptions.fontMatchingChapterId,
    profile: pageOptions.fontMatchingProfile,
    candidates: pageOptions.fontMatchingCandidates,
    pageCoordinator,
    pageInference,
  };
}
