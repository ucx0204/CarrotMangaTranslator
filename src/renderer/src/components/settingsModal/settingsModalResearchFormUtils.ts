import { MIN_TAVILY_MAX_CREDITS_PER_RUN } from "../../../../shared/internetResearchTypes";
import type { SettingsFormValues } from "./settingsModalFormValues";
import {
  isValidContextTokens,
  isValidMaxTokens,
} from "./settingsModalTokenValidation";

export function resolveInternetResearchDraft(values: SettingsFormValues) {
  const parsedGemmaMaxOutputTokens = Number(
    values.researchGemmaMaxOutputTokens,
  );
  const parsedGemmaContextTokens = Number(values.researchGemmaContextTokens);
  const parsedApiMaxOutputTokens = Number(values.researchApiMaxOutputTokens);
  const parsedApiContextTokens = Number(values.researchApiContextTokens);
  const parsedCodexMaxOutputTokens = Number(
    values.researchCodexMaxOutputTokens,
  );
  const parsedCodexContextTokens = Number(values.researchCodexContextTokens);
  const parsedTavilyMaxCreditsPerRun = Number(values.tavilyMaxCreditsPerRun);
  return {
    trimmedResearchCodexModel: values.researchCodexModel.trim(),
    trimmedResearchApiModel: values.researchApiModel.trim(),
    trimmedTavilyApiKey: values.tavilyApiKey.trim(),
    parsedResearchGemmaMaxOutputTokens: parsedGemmaMaxOutputTokens,
    parsedResearchGemmaContextTokens: parsedGemmaContextTokens,
    parsedResearchApiMaxOutputTokens: parsedApiMaxOutputTokens,
    parsedResearchApiContextTokens: parsedApiContextTokens,
    parsedResearchCodexMaxOutputTokens: parsedCodexMaxOutputTokens,
    parsedResearchCodexContextTokens: parsedCodexContextTokens,
    parsedTavilyMaxCreditsPerRun,
    researchGemmaMaxOutputTokensValid: isValidMaxTokens(
      parsedGemmaMaxOutputTokens,
    ),
    researchGemmaContextTokensValid: isValidContextTokens(
      parsedGemmaContextTokens,
    ),
    researchApiMaxOutputTokensValid: isValidMaxTokens(parsedApiMaxOutputTokens),
    researchApiContextTokensValid: isValidContextTokens(parsedApiContextTokens),
    researchCodexMaxOutputTokensValid: isValidMaxTokens(
      parsedCodexMaxOutputTokens,
    ),
    researchCodexContextTokensValid: isValidContextTokens(
      parsedCodexContextTokens,
    ),
    tavilyMaxCreditsPerRunValid:
      Number.isInteger(parsedTavilyMaxCreditsPerRun) &&
      Number.isSafeInteger(parsedTavilyMaxCreditsPerRun) &&
      parsedTavilyMaxCreditsPerRun >= MIN_TAVILY_MAX_CREDITS_PER_RUN,
  };
}

export function isInternetResearchDraftSubmittable(
  values: SettingsFormValues,
  draft: SubmittableInternetResearchDraft,
): boolean {
  if (!areResearchLimitsValid(draft)) return false;
  if (!draft.trimmedResearchCodexModel) return false;
  if (values.researchTavilyAnalysisProvider !== "api") return true;
  return isResearchApiReady(values, draft);
}

type SubmittableInternetResearchDraft = ReturnType<
  typeof resolveInternetResearchDraft
> & {
  apiAdvancedSettingsValid: boolean;
  apiBaseUrlValid: boolean;
  trimmedApiVertexServiceAccountPath: string;
};

function areResearchLimitsValid(
  draft: SubmittableInternetResearchDraft,
): boolean {
  return [
    draft.researchGemmaMaxOutputTokensValid,
    draft.researchGemmaContextTokensValid,
    draft.researchApiMaxOutputTokensValid,
    draft.researchApiContextTokensValid,
    draft.researchCodexMaxOutputTokensValid,
    draft.researchCodexContextTokensValid,
    draft.tavilyMaxCreditsPerRunValid,
  ].every(Boolean);
}

function isResearchApiReady(
  values: SettingsFormValues,
  draft: SubmittableInternetResearchDraft,
): boolean {
  const vertexServiceAccountReady =
    values.apiProvider !== "google-vertex" ||
    values.apiVertexAuthMode !== "service-account" ||
    Boolean(draft.trimmedApiVertexServiceAccountPath);
  return Boolean(
    draft.trimmedResearchApiModel &&
    draft.apiBaseUrlValid &&
    draft.apiAdvancedSettingsValid &&
    vertexServiceAccountReady,
  );
}
