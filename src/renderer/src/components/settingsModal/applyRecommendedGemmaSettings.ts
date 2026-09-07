import type { AppSettings } from "../../../../shared/settingsTypes";
import {
  createSettingsFormValues,
  type SettingsFormValues,
} from "./settingsModalFormValues";

/** Only resets local model configuration; providers and unrelated unsaved edits stay intact. */
export function applyRecommendedGemmaSettings(
  current: SettingsFormValues,
  settings: AppSettings,
): SettingsFormValues {
  const recommended = createSettingsFormValues(settings);
  const keys = [
    "modelSource",
    "selectedPreset",
    "customModelRepo",
    "customModelFile",
    "localModelPath",
    "localMmprojPath",
    "customVramMode",
    "gemmaFitTargetMb",
    "gemmaMmprojOffload",
    "llamaRuntimeProfile",
    "allowUnsafeUnifiedMemory",
    "researchGemmaReasoningEffort",
    "researchGemmaMaxOutputTokens",
    "researchGemmaContextTokens",
  ] as const;
  const next = { ...current };
  for (const key of keys) Object.assign(next, { [key]: recommended[key] });
  next.researchGemmaPreset =
    recommended.selectedPreset === "custom"
      ? settings.gemma.vramMode
      : recommended.selectedPreset;
  next.generationLimitProfiles = {
    ...current.generationLimitProfiles,
    gemma: { ...recommended.generationLimitProfiles.gemma },
  };
  if (current.modelProvider === "gemma") {
    next.maxTokens = next.generationLimitProfiles.gemma.maxTokens;
    next.contextTokens = next.generationLimitProfiles.gemma.contextTokens;
  }
  return next;
}
