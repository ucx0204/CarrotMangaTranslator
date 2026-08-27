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
import { readOptionalGpuLayersEnv } from "./gemmaGpuLayersEnv";

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
  | "fitEnabled"
  | "gpuLayers"
  | "cacheTypeK"
  | "cacheTypeV"
  | "ctxCheckpoints"
  | "kvOffload"
  | "mmprojOffload"
  | "disableMmap"
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
  | "draftSpecType"
  | "draftMaxTokens"
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
      { min: 0, max: 16384, integer: true },
    ),
  };
}

type GemmaGpuFieldOptions = Pick<
  GemmaFieldOptions,
  | "gpuLayers"
  | "fitEnabled"
  | "cacheTypeK"
  | "cacheTypeV"
  | "ctxCheckpoints"
  | "kvOffload"
  | "mmprojOffload"
  | "disableMmap"
>;

export function resolveGemmaGpuOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  preset: GemmaRuntimePreset,
): GemmaGpuFieldOptions {
  return {
    ...resolveConfiguredGemmaGpuMode(runtimeEnv, preset),
    ...resolveGemmaGpuCacheOptions(runtimeEnv, preset),
    ...resolveGemmaGpuMemoryOptions(runtimeEnv, preset),
  };
}

function resolveConfiguredGemmaGpuMode(
  runtimeEnv: NodeJS.ProcessEnv,
  preset: GemmaRuntimePreset,
): Pick<GemmaGpuFieldOptions, "gpuLayers" | "fitEnabled"> {
  const configuredGpuLayers =
    readOptionalGpuLayersEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_GPU_LAYERS") ??
    readOptionalGpuLayersEnv(runtimeEnv, "MANGA_TRANSLATOR_GPU_LAYERS");
  const configuredFitEnabled =
    readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_FIT") ??
    readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_FIT");
  return {
    gpuLayers: configuredGpuLayers ?? preset.gpuLayers,
    fitEnabled:
      configuredFitEnabled ??
      (configuredGpuLayers === "fit" ? true : preset.fitEnabled),
  };
}

function resolveGemmaGpuCacheOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  preset: GemmaRuntimePreset,
): Pick<GemmaGpuFieldOptions, "cacheTypeK" | "cacheTypeV" | "ctxCheckpoints"> {
  return {
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
  };
}

function resolveGemmaGpuMemoryOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  preset: GemmaRuntimePreset,
): Pick<GemmaGpuFieldOptions, "kvOffload" | "mmprojOffload" | "disableMmap"> {
  return {
    kvOffload:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_KV_OFFLOAD") ??
      preset.kvOffload,
    mmprojOffload:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_MMPROJ_OFFLOAD") ??
      preset.mmprojOffload,
    disableMmap:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_NO_MMAP") ??
      preset.disableMmap,
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
  | "draftSpecType"
  | "draftMaxTokens"
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
    ...resolveGemmaDraftOptions(runtimeEnv, preset),
  };
}

function resolveGemmaDraftOptions(
  runtimeEnv: NodeJS.ProcessEnv,
  preset: GemmaRuntimePreset,
): Pick<
  GemmaFieldOptions,
  | "draftModelRepo"
  | "draftModelFile"
  | "draftSpecType"
  | "draftMaxTokens"
  | "useDraft"
> {
  return {
    draftModelRepo:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_DRAFT_MODEL_HF) ??
      preset.draftModelRepo,
    draftModelFile:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_DRAFT_MODEL_FILE) ??
      preset.draftModelFile,
    draftSpecType:
      resolveDraftSpecType(runtimeEnv.MANGA_TRANSLATOR_DRAFT_SPEC_TYPE) ??
      preset.draftSpecType,
    draftMaxTokens:
      readOptionalNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_SPEC_DRAFT_N_MAX", {
        min: 1,
        max: 16,
        integer: true,
      }) ?? preset.draftMaxTokens,
    useDraft:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_USE_DRAFT") ??
      preset.useDraft,
  };
}

function resolveDraftSpecType(
  value: unknown,
): GemmaFieldOptions["draftSpecType"] {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "dflash") return "dflash";
  if (normalized === "draft-mtp" || normalized === "mtp") {
    return "draft-mtp";
  }
  return undefined;
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
