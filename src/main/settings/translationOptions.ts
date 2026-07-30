import type { AppSettings } from "../../shared/settingsTypes";
import { normalizeComputeGpuIndex } from "../../shared/gpuSettings";
import { resolveTranslationLanguageSettings } from "../../shared/translationLanguages";
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
  const computeGpuIndex = normalizeComputeGpuIndex(
    settings.hardware?.computeGpuIndex,
  );
  return {
    imagePath: "",
    outputDir: runDir,
    modelProvider: settings.modelProvider,
    ...resolveTranslationLanguageSettings(settings.translation),
    promptMode: "overlay_bbox_lines_multiview",
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
      runtimeState.gemmaVramMode,
    ),
    ...(computeGpuIndex === undefined ? {} : { computeGpuIndex }),
    ocrRuntimeDir: paths.ocrRuntimeDir,
    hfHomeDir: paths.hfHomeDir,
    hfHubCacheDir: paths.hfHubCacheDir,
    llamaCacheDir: paths.llamaCacheDir,
    ...(settings.blockFormatDefaults
      ? { blockFormatDefaults: settings.blockFormatDefaults }
      : {}),
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
