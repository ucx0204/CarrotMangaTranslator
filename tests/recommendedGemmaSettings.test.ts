import { expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { createSettingsFormValues } from "../src/renderer/src/components/settingsModal/settingsModalFormValues";
import { applyRecommendedGemmaSettings } from "../src/renderer/src/components/settingsModal/applyRecommendedGemmaSettings";

it("resets both local Gemma configurations without replacing provider credentials or unsaved edits", () => {
  const settings = resolveDefaultAppSettings({});
  const recommended = createSettingsFormValues(settings);
  const current = {
    ...recommended,
    modelProvider: "openai-api" as const,
    apiKey: "unsaved-key",
    customModelRepo: "old",
    localModelPath: "old.gguf",
    researchGemmaMaxOutputTokens: "99",
    maxTokens: "777",
    contextTokens: "9999",
    codexImageReasoningEffort: "high" as const,
  };
  const next = applyRecommendedGemmaSettings(current, settings);
  expect(next).toMatchObject({
    modelProvider: "openai-api",
    apiKey: "unsaved-key",
    maxTokens: "777",
    contextTokens: "9999",
    codexImageReasoningEffort: "high",
    customModelRepo: recommended.customModelRepo,
    localModelPath: recommended.localModelPath,
    researchGemmaMaxOutputTokens: recommended.researchGemmaMaxOutputTokens,
  });
  expect(current.localModelPath).toBe("old.gguf");
  const local = applyRecommendedGemmaSettings(
    { ...current, modelProvider: "gemma" },
    settings,
  );
  expect(local.maxTokens).toBe(
    recommended.generationLimitProfiles.gemma.maxTokens,
  );
  expect(local.contextTokens).toBe(
    recommended.generationLimitProfiles.gemma.contextTokens,
  );
});
