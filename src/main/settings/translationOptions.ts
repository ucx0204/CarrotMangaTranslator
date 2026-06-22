import type { AppSettings } from "../../shared/settingsTypes";
import type {
  TranslationOptionPaths,
  TranslationOptions,
} from "./appSettingsTypes";
import { resolveCodexReasoningEffort } from "./appSettingsResolvers";
import { resolveApiTranslationOptions } from "./translationApiOptions";
import {
  resolveGemmaTranslationOptions,
  resolveTranslationRuntimeState,
} from "./translationGemmaOptions";
import { resolveOcrTranslationOptions } from "./translationOcrOptions";
import { filterPackagedRuntimeEnv } from "./translationRuntimeEnv";

export type {
  TranslationOptionPaths,
  TranslationOptions,
} from "./appSettingsTypes";
export { filterPackagedRuntimeEnv } from "./translationRuntimeEnv";

export function buildBaseTranslationOptions({
  jobId,
  runDir,
  paths,
  settings,
  env = process.env,
}: {
  jobId: string;
  runDir: string;
  paths: TranslationOptionPaths;
  settings: AppSettings;
  env?: NodeJS.ProcessEnv;
}): TranslationOptions {
  const runtimeEnv = filterPackagedRuntimeEnv(env, paths);
  const runtimeState = resolveTranslationRuntimeState(runtimeEnv, settings);
  return {
    imagePath: "",
    outputDir: runDir,
    modelProvider: settings.modelProvider,
    promptMode: "ko_bbox_lines_multiview",
    ...resolveGemmaTranslationOptions({
      runtimeEnv,
      paths,
      settings,
      state: runtimeState,
    }),
    ...resolveCodexTranslationOptions(runtimeEnv, settings),
    ...resolveApiTranslationOptions(runtimeEnv, settings),
    ...resolveOcrTranslationOptions(
      runtimeEnv,
      settings,
      runtimeState.llamaRuntimeProfile,
    ),
    ocrRuntimeDir: paths.ocrRuntimeDir,
    hfHomeDir: paths.hfHomeDir,
    hfHubCacheDir: paths.hfHubCacheDir,
    llamaCacheDir: paths.llamaCacheDir,
    label: `app-${jobId}`,
  };
}

function resolveCodexTranslationOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
): Pick<
  TranslationOptions,
  "codexModel" | "codexReasoningEffort" | "codexOauthPort"
> {
  return {
    codexModel: settings.codex.model,
    codexReasoningEffort: resolveCodexReasoningEffort(
      runtimeEnv.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT,
      settings.codex.reasoningEffort,
    ),
    codexOauthPort: settings.codex.oauthPort,
  };
}
