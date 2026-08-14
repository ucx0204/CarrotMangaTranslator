import { MIN_CONTEXT_TOKENS } from "../../shared/modelPresets";
import type { AppSettings, GemmaVramMode } from "../../shared/settingsTypes";
import type { TranslationOptions } from "./appSettingsTypes";
import {
  resolveMaxTokens,
  resolveOptionalString,
} from "./appSettingsResolvers";
import {
  readNumberEnv,
  readOptionalBooleanEnv,
  readOptionalNumberEnv,
} from "./envSettings";
import {
  DEFAULT_IMAGE_TOKENS,
  GEMMA_RUNTIME_PRESETS,
} from "./gemmaRuntimePresets";

type GemmaRuntimePreset = (typeof GEMMA_RUNTIME_PRESETS)[GemmaVramMode];

export type GemmaFieldOptions = Pick<
  TranslationOptions,
  | "port"
  | "temperature"
  | "topP"
  | "topK"
  | "maxTokens"
  | "ctx"
  | "batch"
  | "ubatch"
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
>;

export function resolveGemmaGenerationOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  settings: AppSettings,
  settingsCtx: number,
  preset: GemmaRuntimePreset,
): Pick<
  GemmaFieldOptions,
  | "port"
  | "temperature"
  | "topP"
  | "topK"
  | "maxTokens"
  | "ctx"
  | "batch"
  | "ubatch"
  | "fitTargetMb"
> {
  return {
    port: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_LLAMA_PORT", 18180, {
      min: 1,
      max: 65535,
      integer: true,
    }),
    temperature: readNumberEnv(
      runtimeEnv,
      "MANGA_TRANSLATOR_TEMPERATURE",
      0.2,
      { min: 0, max: 2 },
    ),
    topP: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_TOP_P", 0.95, {
      min: 0.01,
      max: 1,
    }),
    topK: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_TOP_K", 64, {
      min: 1,
      max: 500,
      integer: true,
    }),
    maxTokens: resolveMaxTokens(
      runtimeEnv.MANGA_TRANSLATOR_MAX_TOKENS,
      settings.maxTokens,
    ),
    ctx: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_CTX", settingsCtx, {
      min: MIN_CONTEXT_TOKENS,
      integer: true,
    }),
    batch: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_BATCH", preset.batch, {
      min: 1,
      max: 4096,
      integer: true,
    }),
    ubatch: readNumberEnv(
      runtimeEnv,
      "MANGA_TRANSLATOR_UBATCH",
      preset.ubatch,
      {
        min: 1,
        max: 4096,
        integer: true,
      },
    ),
    fitTargetMb: readNumberEnv(
      runtimeEnv,
      "MANGA_TRANSLATOR_FIT_TARGET_MB",
      preset.fitTargetMb,
      { min: 0, max: 8192, integer: true },
    ),
  };
}

export function resolveGemmaGpuOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  preset: GemmaRuntimePreset,
): Pick<
  GemmaFieldOptions,
  | "gpuLayers"
  | "cacheTypeK"
  | "cacheTypeV"
  | "ctxCheckpoints"
  | "kvOffload"
  | "mmprojOffload"
> {
  return {
    gpuLayers:
      readOptionalGpuLayersEnv(
        runtimeEnv,
        "MANGA_TRANSLATOR_GEMMA_GPU_LAYERS",
      ) ??
      readOptionalGpuLayersEnv(runtimeEnv, "MANGA_TRANSLATOR_GPU_LAYERS") ??
      preset.gpuLayers,
    cacheTypeK:
      resolveOptionalString(
        runtimeEnv.MANGA_TRANSLATOR_GEMMA_CACHE_TYPE_K ??
          runtimeEnv.MANGA_TRANSLATOR_CACHE_TYPE_K,
      ) ?? preset.cacheTypeK,
    cacheTypeV:
      resolveOptionalString(
        runtimeEnv.MANGA_TRANSLATOR_GEMMA_CACHE_TYPE_V ??
          runtimeEnv.MANGA_TRANSLATOR_CACHE_TYPE_V,
      ) ?? preset.cacheTypeV,
    ctxCheckpoints:
      readOptionalNumberEnv(
        runtimeEnv,
        "MANGA_TRANSLATOR_GEMMA_CTX_CHECKPOINTS",
        { min: 0, max: 64, integer: true },
      ) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_CTX_CHECKPOINTS", {
        min: 0,
        max: 64,
        integer: true,
      }) ??
      preset.ctxCheckpoints,
    kvOffload:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_KV_OFFLOAD") ??
      preset.kvOffload,
    mmprojOffload:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_MMPROJ_OFFLOAD") ??
      preset.mmprojOffload,
  };
}

export function resolveGemmaThreadOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  preset: GemmaRuntimePreset,
): Pick<
  GemmaFieldOptions,
  "threads" | "threadsBatch" | "poll" | "pollBatch" | "prioBatch"
> {
  return {
    threads:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_THREADS", {
        min: 1,
        max: 128,
        integer: true,
      }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_THREADS", {
        min: 1,
        max: 128,
        integer: true,
      }) ??
      preset.threads,
    threadsBatch:
      readOptionalNumberEnv(
        runtimeEnv,
        "MANGA_TRANSLATOR_GEMMA_THREADS_BATCH",
        { min: 1, max: 128, integer: true },
      ) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_THREADS_BATCH", {
        min: 1,
        max: 128,
        integer: true,
      }) ??
      preset.threadsBatch,
    poll:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_POLL", {
        min: 0,
        max: 100,
        integer: true,
      }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_POLL", {
        min: 0,
        max: 100,
        integer: true,
      }) ??
      preset.poll,
    pollBatch:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_POLL_BATCH") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_POLL_BATCH") ??
      preset.pollBatch,
    prioBatch:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_PRIO_BATCH", {
        min: -1,
        max: 3,
        integer: true,
      }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_PRIO_BATCH", {
        min: -1,
        max: 3,
        integer: true,
      }) ??
      preset.prioBatch,
  };
}

export function resolveGemmaCacheOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  preset: GemmaRuntimePreset,
): Pick<
  GemmaFieldOptions,
  | "cacheIdleSlots"
  | "cacheReuse"
  | "enableMetrics"
  | "enablePerf"
  | "draftModelRepo"
  | "draftModelFile"
  | "useDraft"
> {
  return {
    cacheIdleSlots:
      readOptionalBooleanEnv(
        runtimeEnv,
        "MANGA_TRANSLATOR_GEMMA_CACHE_IDLE_SLOTS",
      ) ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_CACHE_IDLE_SLOTS") ??
      preset.cacheIdleSlots,
    cacheReuse:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_CACHE_REUSE", {
        min: 0,
        max: 4096,
        integer: true,
      }) ??
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_CACHE_REUSE", {
        min: 0,
        max: 4096,
        integer: true,
      }) ??
      preset.cacheReuse,
    enableMetrics:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_METRICS") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_METRICS") ??
      preset.enableMetrics,
    enablePerf:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_PERF") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_PERF") ??
      preset.enablePerf,
    draftModelRepo:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_DRAFT_MODEL_HF) ??
      preset.draftModelRepo,
    draftModelFile:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_DRAFT_MODEL_FILE) ??
      preset.draftModelFile,
    useDraft:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_USE_DRAFT") ??
      preset.useDraft,
  };
}

export function resolveGemmaImageOptions(
  runtimeEnv: NodeJS.ProcessEnv,
): Pick<
  GemmaFieldOptions,
  | "imageMinTokens"
  | "imageMaxTokens"
  | "includeEnhancedVariant"
  | "enhancedMaxLongSide"
  | "enhancedContrast"
  | "imageFirst"
  | "reuseServer"
> {
  return {
    imageMinTokens: readNumberEnv(
      runtimeEnv,
      "MANGA_TRANSLATOR_IMAGE_MIN_TOKENS",
      DEFAULT_IMAGE_TOKENS,
      { min: 70, max: 2048, integer: true },
    ),
    imageMaxTokens: readNumberEnv(
      runtimeEnv,
      "MANGA_TRANSLATOR_IMAGE_MAX_TOKENS",
      DEFAULT_IMAGE_TOKENS,
      { min: 70, max: 2048, integer: true },
    ),
    includeEnhancedVariant: false,
    enhancedMaxLongSide: 1900,
    enhancedContrast: 1.35,
    imageFirst: true,
    reuseServer: true,
  };
}

function readOptionalGpuLayersEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): number | "fit" | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "fit") {
    return "fit";
  }
  if (normalized === "all") {
    return undefined;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value) : undefined;
}
