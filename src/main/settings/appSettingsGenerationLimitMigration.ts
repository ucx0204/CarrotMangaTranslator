import { resolveRecommendedGenerationLimits } from "../../shared/modelPresets";
import type { AppSettings } from "../../shared/settingsTypes";
import { asRecord } from "./appSettingsResolvers";

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
  const recommended = resolveRecommendedGenerationLimits(
    normalized.modelProvider,
    activeModel,
  );
  return {
    ...normalized,
    maxTokens: recommended.maxTokens,
    ctx: recommended.contextTokens,
  };
}
