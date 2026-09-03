import type {
  AppSettings,
  GenerationLimitProfiles,
  GenerationLimitSettings,
  ResolvedApiSettings,
} from "../../shared/settingsTypes";
import { resolveContextTokens, resolveMaxTokens } from "./appSettingsResolvers";
import { resolveAppGenerationLimits } from "./appSettingsGenerationLimits";

export function resolveDefaultGenerationLimits({
  api,
  codex,
  env,
  modelProvider,
}: {
  api: ResolvedApiSettings;
  codex: AppSettings["codex"];
  env: NodeJS.ProcessEnv;
  modelProvider: AppSettings["modelProvider"];
}): GenerationLimitProfiles {
  const profiles = createRecommendedProfiles(api, codex);
  const active = resolveActiveGenerationLimits(profiles, modelProvider, api);
  active.maxTokens = resolveMaxTokens(
    env.MANGA_TRANSLATOR_MAX_TOKENS,
    active.maxTokens,
  );
  active.contextTokens = resolveContextTokens(
    env.MANGA_TRANSLATOR_CTX,
    active.contextTokens,
  );
  return profiles;
}

export function resolveActiveGenerationLimits(
  profiles: GenerationLimitProfiles,
  modelProvider: AppSettings["modelProvider"],
  api: ResolvedApiSettings,
): GenerationLimitSettings {
  if (modelProvider === "gemma") return profiles.gemma;
  if (modelProvider === "openai-codex") return profiles.codex;
  return profiles.api[api.provider] ?? profiles.codex;
}

function createRecommendedProfiles(
  api: ResolvedApiSettings,
  codex: AppSettings["codex"],
): GenerationLimitProfiles {
  const gemma = resolveAppGenerationLimits("gemma");
  const codexLimits = resolveAppGenerationLimits("openai-codex", codex.model);
  const apiLimits = resolveAppGenerationLimits("openai-api", api.model);
  return {
    gemma: toGenerationLimits(gemma),
    codex: toGenerationLimits(codexLimits),
    api: { [api.provider]: toGenerationLimits(apiLimits) },
  };
}

function toGenerationLimits(limits: {
  maxTokens: number;
  contextTokens: number;
}): GenerationLimitSettings {
  return {
    maxTokens: limits.maxTokens,
    contextTokens: limits.contextTokens,
  };
}
