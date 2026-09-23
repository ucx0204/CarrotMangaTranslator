import type { AppSettings } from "../../shared/settingsTypes";
import {
  isCodexImageModel,
  CODEX_IMAGE_GENERATION_MODELS,
} from "../../shared/codexSettings";
import { CODEX_TYPESETTING_MODEL } from "../../shared/codexTypesettingDefaults";
import {
  resolveCodexReasoningEffort,
  resolveNonEmptyString,
} from "./appSettingsResolvers";

export function normalizeCodexSettings(
  codex: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["codex"] {
  const imageModel = codex?.imageModel;
  return {
    imageGenerationModel:
      CODEX_IMAGE_GENERATION_MODELS.find(
        (model) => model === codex?.imageGenerationModel,
      ) ?? "gpt-image-2.5-flare",
    imageModel: isCodexImageModel(imageModel)
      ? imageModel
      : CODEX_TYPESETTING_MODEL,
    imageReasoningEffort: resolveCodexReasoningEffort(
      codex?.imageReasoningEffort,
      "low",
    ),
    model: resolveNonEmptyString(codex?.model, defaults.codex.model),
    reasoningEffort: resolveCodexReasoningEffort(
      codex?.reasoningEffort,
      defaults.codex.reasoningEffort,
    ),
  };
}
