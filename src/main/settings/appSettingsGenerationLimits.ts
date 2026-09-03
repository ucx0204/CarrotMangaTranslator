import { resolveRecommendedGenerationLimits } from "../../shared/modelPresets";
import type {
  GenerationLimitSettings,
  ModelProvider,
} from "../../shared/settingsTypes";

export function resolveAppGenerationLimits(
  provider: ModelProvider,
  model?: string,
): GenerationLimitSettings {
  const limits = resolveRecommendedGenerationLimits(provider, model);
  return {
    maxTokens: limits.maxTokens,
    contextTokens: limits.contextTokens,
  };
}
