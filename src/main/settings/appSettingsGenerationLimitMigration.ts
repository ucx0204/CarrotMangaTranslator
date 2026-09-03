import type { AppSettings } from "../../shared/settingsTypes";
import { inferApiProviderPreset } from "../../shared/apiProviderPresets";
import { asRecord } from "./appSettingsResolvers";
import { resolveAppGenerationLimits } from "./appSettingsGenerationLimits";

export const CURRENT_GENERATION_LIMITS_VERSION = 1;
const LEGACY_GEMMA_MAX_TOKENS = 12000;
const LEGACY_GEMMA_CONTEXT_TOKENS = 16384;

export function migrateLegacyRemoteGenerationLimits(
  raw: unknown,
  normalized: AppSettings,
): AppSettings {
  const record = asRecord(raw);
  if (
    !record ||
    !normalized.generationLimits ||
    record.generationLimitsVersion === CURRENT_GENERATION_LIMITS_VERSION ||
    normalized.modelProvider === "gemma" ||
    record.maxTokens !== LEGACY_GEMMA_MAX_TOKENS ||
    record.ctx !== LEGACY_GEMMA_CONTEXT_TOKENS
  ) {
    return normalized;
  }

  const activeModel =
    normalized.modelProvider === "openai-codex"
      ? normalized.codex.model
      : normalized.api.model;
  const recommended = resolveAppGenerationLimits(
    normalized.modelProvider,
    activeModel,
  );
  const migratedLimits = {
    maxTokens: recommended.maxTokens,
    contextTokens: recommended.contextTokens,
  };
  const generationLimits = {
    ...normalized.generationLimits,
    api: { ...normalized.generationLimits.api },
  };
  if (normalized.modelProvider === "openai-codex") {
    generationLimits.codex = migratedLimits;
  } else {
    const apiProvider =
      normalized.api.provider ?? inferApiProviderPreset(normalized.api.baseUrl);
    generationLimits.api[apiProvider] = migratedLimits;
  }
  return {
    ...normalized,
    generationLimits,
    maxTokens: recommended.maxTokens,
    ctx: recommended.contextTokens,
  };
}
