import type { AppSettings } from "../../shared/settingsTypes";
import { resolveDefaultApiSettings } from "./appSettingsApiDefaults";
import {
  resolveActiveGenerationLimits,
  resolveDefaultGenerationLimits,
} from "./appSettingsGenerationLimitDefaults";
import { resolveDefaultInternetResearchSettings } from "./appSettingsInternetResearchNormalize";

export function resolveDefaultRemoteSettings(
  env: NodeJS.ProcessEnv,
  modelProvider: AppSettings["modelProvider"],
  codex: AppSettings["codex"],
) {
  const api = resolveDefaultApiSettings(env);
  const generationLimits = resolveDefaultGenerationLimits({
    api,
    codex,
    env,
    modelProvider,
  });
  return {
    api,
    internetResearch: resolveDefaultInternetResearchSettings(codex, api),
    generationLimits,
    activeLimits: resolveActiveGenerationLimits(
      generationLimits,
      modelProvider,
      api,
    ),
  };
}
