import type { TFunction } from "i18next";
import type { SettingsDraft } from "./settingsModalFormUtils";
import type { SettingsFormValues } from "./settingsModalFormValues";

export type SettingsSubmissionIssue = {
  tab: "translation" | "research";
  label: string;
  message: string;
};

/** Read the same parsed validation results used by the submission boundary. */
export function getSettingsSubmissionIssue(
  values: SettingsFormValues,
  draft: SettingsDraft,
  t: TFunction<"components">,
): SettingsSubmissionIssue | undefined {
  const invalid = (
    valid: unknown,
    label: string,
    tab: SettingsSubmissionIssue["tab"] = "translation",
  ) =>
    valid
      ? undefined
      : {
          tab,
          label,
          message: t("settings.validation.reviewField", { field: label }),
        };
  return [
    invalid(draft.maxTokensValid, t("settings.engine.maxTokens.label")),
    invalid(
      draft.contextTokensValid,
      t("settings.engine.contextTokens.modelLabel"),
    ),
    ...researchIssues(draft, t),
    invalid(draft.sourceLanguageValid, t("settings.translation.source")),
    invalid(draft.targetLanguageValid, t("settings.translation.target")),
    values.modelProvider === "openai-codex"
      ? invalid(draft.trimmedCodexModel, t("settings.codex.model"))
      : undefined,
    values.modelProvider === "gemma"
      ? invalid(
          values.modelSource === "local"
            ? draft.trimmedLocalModelPath
            : draft.trimmedModelRepo && draft.trimmedModelFile,
          t("settings.validation.modelLocation"),
        )
      : undefined,
    values.modelProvider === "openai-api"
      ? invalid(draft.trimmedApiModel, t("settings.api.model"))
      : undefined,
    values.researchTavilyAnalysisProvider === "api"
      ? invalid(
          draft.trimmedResearchApiModel,
          t("settings.api.model"),
          "research",
        )
      : undefined,
    values.modelProvider === "openai-api" ||
    values.researchTavilyAnalysisProvider === "api"
      ? apiIssue(values, draft, t)
      : undefined,
  ].find((issue) => issue !== undefined);
}

function researchIssues(draft: SettingsDraft, t: TFunction<"components">) {
  const fields = [
    [
      draft.researchGemmaMaxOutputTokensValid,
      "Gemma · " + t("settings.engine.maxTokens.label"),
    ],
    [
      draft.researchGemmaContextTokensValid,
      "Gemma · " + t("settings.engine.contextTokens.modelLabel"),
    ],
    [
      draft.researchApiMaxOutputTokensValid,
      "API · " + t("settings.engine.maxTokens.label"),
    ],
    [
      draft.researchApiContextTokensValid,
      "API · " + t("settings.engine.contextTokens.modelLabel"),
    ],
    [
      draft.researchCodexMaxOutputTokensValid,
      "Codex · " + t("settings.engine.maxTokens.label"),
    ],
    [
      draft.researchCodexContextTokensValid,
      "Codex · " + t("settings.engine.contextTokens.modelLabel"),
    ],
    [draft.tavilyMaxCreditsPerRunValid, t("settings.research.tavily.perRun")],
    [draft.trimmedResearchCodexModel, "Codex · " + t("settings.api.model")],
  ] as const;
  return fields
    .filter(([valid]) => !valid)
    .map(([, label]) => ({
      tab: "research" as const,
      label,
      message: t("settings.validation.reviewField", { field: label }),
    }));
}

function apiIssue(
  values: SettingsFormValues,
  draft: SettingsDraft,
  t: TFunction<"components">,
): SettingsSubmissionIssue | undefined {
  const tab =
    values.modelProvider === "openai-api" ? "translation" : "research";
  if (!draft.apiBaseUrlValid)
    return {
      tab,
      label: t("settings.api.baseUrl"),
      message: t("settings.validation.apiBaseUrl"),
    };
  const fields = [
    [draft.parsedApiTemperature, "settings.api.advanced.temperature"],
    [draft.parsedApiTopP, "settings.api.advanced.topP"],
    [draft.parsedApiTopK, "settings.api.advanced.topK"],
    [draft.apiKeyMaxAttemptsValidation, "settings.api.keyMaxAttempts"],
    [draft.apiRetryDelaySecondsValidation, "settings.api.retryDelaySeconds"],
    [
      draft.apiRequestIntervalSecondsValidation,
      "settings.api.requestIntervalSeconds",
    ],
    [draft.apiKeysValidation, "settings.api.key"],
    [draft.apiExtraBodyValidation, "settings.api.advanced.extraBody"],
    [draft.apiCustomHeadersValidation, "settings.api.advanced.customHeaders"],
  ] as const;
  const entry = fields.find(([result]) => !result.valid);
  if (entry) {
    const [result, labelKey] = entry;
    const label = t(labelKey);
    return {
      tab,
      label,
      message: result.messageKey
        ? `${label}: ${t(result.messageKey, result.messageValues)}`
        : t("settings.validation.reviewField", { field: label }),
    };
  }
  if (
    values.apiProvider === "google-vertex" &&
    values.apiVertexAuthMode === "service-account" &&
    !draft.trimmedApiVertexServiceAccountPath
  ) {
    const label = t("settings.api.vertexServiceAccountNotSelected");
    return {
      tab,
      label,
      message: t("settings.validation.reviewField", { field: label }),
    };
  }
  return undefined;
}
