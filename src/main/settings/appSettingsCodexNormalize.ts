import type { AppSettings } from "../../shared/settingsTypes";
import { CODEX_IMAGE_MODELS } from "../../shared/codexSettings";
import {
  resolveCodexReasoningEffort,
  resolveNonEmptyString,
} from "./appSettingsResolvers";

export function normalizeCodexSettings(
  codex: Record<string, unknown> | null,
  defaults: AppSettings,
): AppSettings["codex"] {
  return {
    imageModel:
      CODEX_IMAGE_MODELS.find((model) => model === codex?.imageModel) ??
      CODEX_IMAGE_MODELS[0],
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
