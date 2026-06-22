import { readBooleanLikeEnv } from "./envSettings";
import type { TranslationOptionPaths } from "./appSettingsTypes";

const PACKAGED_RUNTIME_ENV_KEYS = [
  "MANGA_TRANSLATOR_API_BASE_URL",
  "MANGA_TRANSLATOR_API_MODEL",
  "MANGA_TRANSLATOR_API_KEY",
  "MANGA_TRANSLATOR_API_TEMPERATURE",
  "MANGA_TRANSLATOR_API_TOP_P",
  "MANGA_TRANSLATOR_API_TOP_K",
  "MANGA_TRANSLATOR_API_REASONING_EFFORT",
  "MANGA_TRANSLATOR_API_EXTRA_BODY",
  "MANGA_TRANSLATOR_API_HEADERS",
  "OPENAI_API_KEY",
  "MANGA_TRANSLATOR_AMD_ROCM_TARGET",
  "MANGA_TRANSLATOR_AMD_GFX_ARCH",
] as const;

export function filterPackagedRuntimeEnv(
  env: NodeJS.ProcessEnv,
  paths: Pick<TranslationOptionPaths, "isPackaged">,
): NodeJS.ProcessEnv {
  if (!shouldFilterPackagedRuntimeEnv(env, paths)) {
    return env;
  }
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of PACKAGED_RUNTIME_ENV_KEYS) {
    if (env[key]) {
      filtered[key] = env[key];
    }
  }
  return filtered;
}

function shouldFilterPackagedRuntimeEnv(
  env: NodeJS.ProcessEnv,
  paths: Pick<TranslationOptionPaths, "isPackaged">,
): boolean {
  return (
    paths.isPackaged === true &&
    readBooleanLikeEnv(
      env.MGT_ALLOW_EXTERNAL_RUNTIME ??
        env.MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME,
    ) !== true
  );
}
