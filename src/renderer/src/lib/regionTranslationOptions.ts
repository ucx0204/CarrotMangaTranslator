import type { AppSettings } from "../../../shared/settingsTypes";
import type { RegionAnalysisRequest } from "../../../shared/analysisTypes";
import { resolveCodexTypesettingOptions } from "../../../shared/codexTypesettingDefaults";
import type { MangaPage } from "../../../shared/libraryTypes";
import type { BBox } from "../../../shared/textTypes";

export type RegionTranslationChoices = {
  output: "text" | "image";
  eraseOriginal: boolean;
};
export type RegionTranslationDialog = {
  busy?: boolean;
  unavailable?: boolean;
  error?: string;
  review?: import("../../../shared/regionTextReview").RegionTextReview;
  onConfirm?: (
    translations: import("../../../shared/regionTextReview").ConfirmRegionTranslationRequest["translations"],
  ) => void;
  page: MangaPage;
  bbox: BBox;
  codexDelegateAll: boolean;
  codexImageAvailable?: boolean;
  initial: RegionTranslationChoices;
  onClose: () => void;
  onRun: (choices: RegionTranslationChoices) => void;
};

export function buildRegionTranslationRequest(
  settings: AppSettings | null | undefined,
  choices: RegionTranslationChoices,
  delegated: boolean,
): Partial<RegionAnalysisRequest> {
  if (!delegated && choices.output !== "image")
    return { eraseOriginal: choices.eraseOriginal };
  const defaults = resolveCodexTypesettingOptions(
    settings?.ui?.codexTypesettingPreferences,
    settings?.translation?.targetLanguage ?? "ko",
  );
  return {
    eraseOriginal: choices.eraseOriginal,
    codexTypesetting: {
      ...defaults,
      eraseOriginal: choices.eraseOriginal,
      regionOutput: choices.output,
      sfxRendering: choices.output === "image" ? "image" : "font",
    },
  };
}
