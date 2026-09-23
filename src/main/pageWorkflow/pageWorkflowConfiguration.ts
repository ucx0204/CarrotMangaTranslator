import { hashStableValue } from "../../shared/blockFingerprint";
import type { AppSettings } from "../../shared/settingsTypes";
import type { PageWorkflowStage } from "../../shared/pageWorkflowStages";

/** Persist only fingerprints, never credentials or a copy of application settings. */
export function workflowConfigurationKeys(
  settings: AppSettings,
): Partial<Record<PageWorkflowStage, string>> {
  const model =
    settings.modelProvider === "gemma"
      ? settings.gemma
      : settings.modelProvider === "openai-codex"
        ? settings.codex
        : {
            provider: settings.api.provider,
            baseUrl: settings.api.baseUrl,
            model: settings.api.model,
            temperature: settings.api.temperature,
            topP: settings.api.topP,
            topK: settings.api.topK,
            reasoningEffort: settings.api.reasoningEffort,
            extraBodyJson: settings.api.extraBodyJson,
          };
  return {
    detect: hashStableValue([
      settings.ocr.pipeline,
      settings.blockFormatDefaults,
    ]),
    ocr: hashStableValue([settings.ocr, settings.translation?.sourceLanguage]),
    translate: hashStableValue([
      settings.modelProvider,
      model,
      settings.translation,
      settings.maxTokens,
      settings.ctx,
    ]),
    typography: hashStableValue([settings.translation, settings.ocr]),
    erase: hashStableValue([
      settings.inpainting,
      settings.codex.imageModel,
      settings.codex.imageGenerationModel,
      settings.codex.imageReasoningEffort,
    ]),
    layout: hashStableValue([settings.translation?.targetLanguage]),
  };
}
