import { DEFAULT_GEMMA_CONTEXT_TOKENS } from "../../shared/modelPresets";
import type {
  AppSettings,
  GemmaVramMode,
  LlamaRuntimeProfile,
} from "../../shared/settingsTypes";
import { normalizeAmdRocmTarget } from "../gpuInfo";
import type {
  TranslationOptionPaths,
  TranslationOptions,
} from "./appSettingsTypes";
import {
  resolveContextTokens,
  resolveGemmaVramMode,
  resolveOptionalString,
} from "./appSettingsResolvers";
import {
  resolveGemmaCacheOptions,
  resolveGemmaGenerationOptions,
  resolveGemmaGpuOptions,
  resolveGemmaImageOptions,
  resolveGemmaThreadOptions,
} from "./translationGemmaFieldOptions";
import { GEMMA_RUNTIME_PRESETS } from "./gemmaRuntimePresets";
import {
  getDefaultMmprojForGemmaModel,
  resolveRuntimeGemmaSettings,
} from "./gemmaModelPresets";
import {
  isMetalLlamaRuntimeProfile,
  resolveLlamaRuntimeProfile,
} from "./llamaRuntimeProfile";
import { resolveDefaultLlamaServerPathForGemma } from "./translationLlamaServerPath";

type GemmaRuntimePreset = (typeof GEMMA_RUNTIME_PRESETS)[GemmaVramMode];

export type TranslationRuntimeState = {
  gemmaVramMode: GemmaVramMode;
  gemmaRuntimePreset: GemmaRuntimePreset;
  settingsCtx: number;
  runtimeGemma: AppSettings["gemma"];
  llamaRuntimeProfile: LlamaRuntimeProfile;
  llamaRocmTarget?: string;
  unifiedMemoryMb?: number;
  allowUnsafeUnifiedMemory: boolean;
};

type GemmaTranslationOptions = Pick<
  TranslationOptions,
  | "port"
  | "temperature"
  | "topP"
  | "topK"
  | "maxTokens"
  | "ctx"
  | "batch"
  | "ubatch"
  | "gemmaVramMode"
  | "fitTargetMb"
  | "gpuLayers"
  | "cacheTypeK"
  | "cacheTypeV"
  | "ctxCheckpoints"
  | "kvOffload"
  | "mmprojOffload"
  | "threads"
  | "threadsBatch"
  | "poll"
  | "pollBatch"
  | "prioBatch"
  | "cacheIdleSlots"
  | "cacheReuse"
  | "enableMetrics"
  | "enablePerf"
  | "draftModelRepo"
  | "draftModelFile"
  | "useDraft"
  | "imageMinTokens"
  | "imageMaxTokens"
  | "includeEnhancedVariant"
  | "enhancedMaxLongSide"
  | "enhancedContrast"
  | "imageFirst"
  | "reuseServer"
  | "llamaRuntimeProfile"
  | "llamaRocmTarget"
  | "unifiedMemoryMb"
  | "allowUnsafeUnifiedMemory"
  | "workingDir"
  | "toolsDir"
  | "serverPath"
  | "modelSource"
  | "modelRepo"
  | "modelFile"
  | "mmprojRepo"
  | "mmprojFile"
  | "localModelPath"
  | "localMmprojPath"
>;

export function resolveTranslationRuntimeState(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
): TranslationRuntimeState {
  const gemmaVramMode = resolveGemmaVramMode(
    runtimeEnv.MANGA_TRANSLATOR_GEMMA_VRAM_MODE,
    settings.gemma.vramMode,
  );
  const llamaRuntimeProfile = resolveLlamaRuntimeProfile(
    runtimeEnv,
    settings.gemma.llamaRuntimeProfile,
  );
  const baseRuntimePreset = GEMMA_RUNTIME_PRESETS[gemmaVramMode];
  const gemmaRuntimePreset =
    isMetalLlamaRuntimeProfile(llamaRuntimeProfile) &&
    gemmaVramMode !== "full31b"
      ? { ...baseRuntimePreset, fitTargetMb: 4096 }
      : baseRuntimePreset;
  return {
    gemmaVramMode,
    gemmaRuntimePreset,
    settingsCtx: resolveContextTokens(
      settings.ctx,
      gemmaRuntimePreset.ctx || DEFAULT_GEMMA_CONTEXT_TOKENS,
    ),
    runtimeGemma: resolveRuntimeGemmaSettings(settings.gemma, gemmaVramMode),
    llamaRuntimeProfile,
    llamaRocmTarget: resolveLlamaRocmTarget(runtimeEnv, settings),
    ...(typeof settings.runtimeHardware?.unifiedMemoryMb === "number"
      ? { unifiedMemoryMb: settings.runtimeHardware.unifiedMemoryMb }
      : {}),
    allowUnsafeUnifiedMemory: settings.gemma.allowUnsafeUnifiedMemory === true,
  };
}

export function resolveGemmaTranslationOptions({
  runtimeEnv,
  paths,
  settings,
  state,
}: {
  runtimeEnv: NodeJS.ProcessEnv;
  paths: TranslationOptionPaths;
  settings: AppSettings;
  state: TranslationRuntimeState;
}): GemmaTranslationOptions {
  return {
    ...resolveGemmaGenerationOptions(
      runtimeEnv,
      settings,
      state.settingsCtx,
      state.gemmaRuntimePreset,
    ),
    gemmaVramMode: state.gemmaVramMode,
    ...resolveGemmaGpuOptions(runtimeEnv, state.gemmaRuntimePreset),
    ...resolveGemmaThreadOptions(runtimeEnv, state.gemmaRuntimePreset),
    ...resolveGemmaCacheOptions(runtimeEnv, state.gemmaRuntimePreset),
    ...resolveGemmaImageOptions(runtimeEnv),
    ...resolveGemmaModelOptions(runtimeEnv, paths, state),
  };
}

function resolveLlamaRocmTarget(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
): string | undefined {
  return (
    normalizeAmdRocmTarget(
      runtimeEnv.MANGA_TRANSLATOR_AMD_ROCM_TARGET ??
        runtimeEnv.MANGA_TRANSLATOR_AMD_GFX_ARCH,
    ) ??
    normalizeAmdRocmTarget(settings.gemma.llamaRocmTarget) ??
    normalizeAmdRocmTarget(settings.runtimeHardware?.llamaRocmTarget) ??
    undefined
  );
}

function resolveGemmaModelOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  paths: TranslationOptionPaths,
  state: TranslationRuntimeState,
): Pick<
  GemmaTranslationOptions,
  | "llamaRuntimeProfile"
  | "llamaRocmTarget"
  | "unifiedMemoryMb"
  | "allowUnsafeUnifiedMemory"
  | "workingDir"
  | "toolsDir"
  | "serverPath"
  | "modelSource"
  | "modelRepo"
  | "modelFile"
  | "mmprojRepo"
  | "mmprojFile"
  | "localModelPath"
  | "localMmprojPath"
> {
  return {
    llamaRuntimeProfile: state.llamaRuntimeProfile,
    ...(state.llamaRocmTarget
      ? { llamaRocmTarget: state.llamaRocmTarget }
      : {}),
    ...(typeof state.unifiedMemoryMb === "number"
      ? { unifiedMemoryMb: state.unifiedMemoryMb }
      : {}),
    allowUnsafeUnifiedMemory: state.allowUnsafeUnifiedMemory,
    workingDir: paths.dataRoot,
    toolsDir: paths.toolsDir,
    serverPath:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_LLAMA_SERVER_PATH) ??
      resolveOptionalString(runtimeEnv.LLAMA_SERVER_PATH) ??
      resolveDefaultLlamaServerPathForGemma(
        paths,
        state.runtimeGemma,
        state.llamaRuntimeProfile,
        state.llamaRocmTarget,
      ),
    modelSource: state.runtimeGemma.modelSource,
    modelRepo:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_MODEL_HF) ??
      state.runtimeGemma.modelRepo,
    modelFile:
      resolveOptionalString(runtimeEnv.LLAMA_ARG_HF_FILE) ??
      state.runtimeGemma.modelFile,
    mmprojRepo: resolveGemmaMmprojRepo(runtimeEnv, state.runtimeGemma),
    mmprojFile: resolveGemmaMmprojFile(runtimeEnv, state.runtimeGemma),
    localModelPath: state.runtimeGemma.localModelPath,
    localMmprojPath: state.runtimeGemma.localMmprojPath,
  };
}

function resolveGemmaMmprojRepo(
  runtimeEnv: NodeJS.ProcessEnv,
  runtimeGemma: AppSettings["gemma"],
): string | undefined {
  if (runtimeGemma.modelSource !== "huggingface") {
    return undefined;
  }
  return (
    resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_MMPROJ_HF) ??
    runtimeGemma.mmprojRepo ??
    getDefaultMmprojForGemmaModel(runtimeGemma)?.mmprojRepo
  );
}

function resolveGemmaMmprojFile(
  runtimeEnv: NodeJS.ProcessEnv,
  runtimeGemma: AppSettings["gemma"],
): string | undefined {
  if (runtimeGemma.modelSource !== "huggingface") {
    return undefined;
  }
  return (
    resolveOptionalString(runtimeEnv.LLAMA_ARG_MMPROJ_FILE) ??
    runtimeGemma.mmprojFile ??
    getDefaultMmprojForGemmaModel(runtimeGemma)?.mmprojFile
  );
}
