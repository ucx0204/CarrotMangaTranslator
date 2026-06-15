import { join } from "node:path";
import { DEFAULT_OCR_GPU_CUDA_TAG } from "../../shared/modelPresets";
import type {
  AppSettings,
  LlamaRuntimeProfile,
  OcrDevice,
  OcrGpuBackend,
} from "../../shared/types";
import { normalizeAmdRocmTarget } from "../gpuInfo";
import type {
  TranslationOptionPaths,
  TranslationOptions,
} from "./appSettingsTypes";
import {
  DEFAULT_IMAGE_TOKENS,
  GEMMA_RUNTIME_PRESETS,
} from "./gemmaRuntimePresets";
import {
  resolveCodexReasoningEffort,
  resolveGemmaVramMode,
  resolveMaxTokens,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOptionalString,
} from "./appSettingsResolvers";
import {
  readBooleanLikeEnv,
  readNumberEnv,
  readOptionalBooleanEnv,
  readOptionalNumberEnv,
} from "./envSettings";
import {
  getDefaultMmprojForGemmaModel,
  isBuiltInGemmaModel,
  isMainlineGemmaModel,
  resolveRuntimeGemmaSettings,
} from "./gemmaModelPresets";
import {
  isRocmLlamaRuntimeProfile,
  isRtx50LlamaRuntimeProfile,
  isVulkanLlamaRuntimeProfile,
  resolveLlamaRuntimeProfile,
} from "./llamaRuntimeProfile";

export type {
  TranslationOptionPaths,
  TranslationOptions,
} from "./appSettingsTypes";

const BEELLAMA_LLAMA_RUNTIME_DIR_CUDA12 = "beellama-v0.2.0-cuda12.4";
const BEELLAMA_LLAMA_RUNTIME_DIR_CUDA13 = "beellama-v0.2.0-cuda13.1";
const MAINLINE_LLAMA_RUNTIME_DIR_CUDA12 = "llama-b9547-cuda12.4";
const MAINLINE_LLAMA_RUNTIME_DIR_CUDA13 = "llama-b9547-cuda13.3";
const LEMONADE_LLAMA_RUNTIME_ROCM_RELEASE = "b1291";
const MAINLINE_LLAMA_RUNTIME_DIR_VULKAN = "llama-b9547-vulkan";

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
  const gemmaVramMode = resolveGemmaVramMode(
    runtimeEnv.MANGA_TRANSLATOR_GEMMA_VRAM_MODE,
    settings.gemma.vramMode,
  );
  const gemmaRuntimePreset = GEMMA_RUNTIME_PRESETS[gemmaVramMode];
  const runtimeGemma = resolveRuntimeGemmaSettings(
    settings.gemma,
    gemmaVramMode,
  );
  const llamaRuntimeProfile = resolveLlamaRuntimeProfile(
    runtimeEnv,
    settings.gemma.llamaRuntimeProfile,
  );
  const ocrGpuBackend = resolveOcrGpuBackend(
    runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_BACKEND,
    settings.ocr.gpuBackend ?? "cuda",
  );
  const ocrDevice = resolveRuntimeOcrDevice(
    runtimeEnv,
    settings.ocr.device,
    llamaRuntimeProfile,
    ocrGpuBackend,
  );
  const ocrGpuCudaTag = resolveOcrGpuCudaTag(
    runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG ??
      runtimeEnv.MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG ??
      runtimeEnv.MANGA_TRANSLATOR_OCR_GPU_CUDA,
    settings.ocr.gpuCudaTag ?? DEFAULT_OCR_GPU_CUDA_TAG,
  );
  const llamaRocmTarget =
    normalizeAmdRocmTarget(
      runtimeEnv.MANGA_TRANSLATOR_AMD_ROCM_TARGET ??
        runtimeEnv.MANGA_TRANSLATOR_AMD_GFX_ARCH,
    ) ??
    normalizeAmdRocmTarget(settings.gemma.llamaRocmTarget) ??
    normalizeAmdRocmTarget(settings.runtimeHardware?.llamaRocmTarget);
  return {
    imagePath: "",
    outputDir: runDir,
    modelProvider: settings.modelProvider,
    port: readNumberEnv(runtimeEnv, "MANGA_TRANSLATOR_LLAMA_PORT", 18180, {
      min: 1,
      max: 65535,
      integer: true,
    }),
    promptMode: "ko_bbox_lines_multiview",
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
    ctx: readNumberEnv(
      runtimeEnv,
      "MANGA_TRANSLATOR_CTX",
      gemmaRuntimePreset.ctx,
      { min: 1024, max: 32768, integer: true },
    ),
    batch: readNumberEnv(
      runtimeEnv,
      "MANGA_TRANSLATOR_BATCH",
      gemmaRuntimePreset.batch,
      { min: 1, max: 4096, integer: true },
    ),
    ubatch: readNumberEnv(
      runtimeEnv,
      "MANGA_TRANSLATOR_UBATCH",
      gemmaRuntimePreset.ubatch,
      { min: 1, max: 4096, integer: true },
    ),
    gemmaVramMode,
    fitTargetMb: readNumberEnv(
      runtimeEnv,
      "MANGA_TRANSLATOR_FIT_TARGET_MB",
      gemmaRuntimePreset.fitTargetMb,
      { min: 0, max: 8192, integer: true },
    ),
    gpuLayers:
      readOptionalGpuLayersEnv(
        runtimeEnv,
        "MANGA_TRANSLATOR_GEMMA_GPU_LAYERS",
      ) ??
      readOptionalGpuLayersEnv(runtimeEnv, "MANGA_TRANSLATOR_GPU_LAYERS") ??
      gemmaRuntimePreset.gpuLayers,
    cacheTypeK:
      resolveOptionalString(
        runtimeEnv.MANGA_TRANSLATOR_GEMMA_CACHE_TYPE_K ??
          runtimeEnv.MANGA_TRANSLATOR_CACHE_TYPE_K,
      ) ?? gemmaRuntimePreset.cacheTypeK,
    cacheTypeV:
      resolveOptionalString(
        runtimeEnv.MANGA_TRANSLATOR_GEMMA_CACHE_TYPE_V ??
          runtimeEnv.MANGA_TRANSLATOR_CACHE_TYPE_V,
      ) ?? gemmaRuntimePreset.cacheTypeV,
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
      gemmaRuntimePreset.ctxCheckpoints,
    kvOffload:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_KV_OFFLOAD") ??
      gemmaRuntimePreset.kvOffload,
    mmprojOffload:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_MMPROJ_OFFLOAD") ??
      gemmaRuntimePreset.mmprojOffload,
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
      gemmaRuntimePreset.threads,
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
      gemmaRuntimePreset.threadsBatch,
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
      gemmaRuntimePreset.poll,
    pollBatch:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_POLL_BATCH") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_POLL_BATCH") ??
      gemmaRuntimePreset.pollBatch,
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
      gemmaRuntimePreset.prioBatch,
    cacheIdleSlots:
      readOptionalBooleanEnv(
        runtimeEnv,
        "MANGA_TRANSLATOR_GEMMA_CACHE_IDLE_SLOTS",
      ) ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_CACHE_IDLE_SLOTS") ??
      gemmaRuntimePreset.cacheIdleSlots,
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
      gemmaRuntimePreset.cacheReuse,
    enableMetrics:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_METRICS") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_METRICS") ??
      gemmaRuntimePreset.enableMetrics,
    enablePerf:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_GEMMA_PERF") ??
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_PERF") ??
      gemmaRuntimePreset.enablePerf,
    draftModelRepo:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_DRAFT_MODEL_HF) ??
      gemmaRuntimePreset.draftModelRepo,
    draftModelFile:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_DRAFT_MODEL_FILE) ??
      gemmaRuntimePreset.draftModelFile,
    useDraft:
      readOptionalBooleanEnv(runtimeEnv, "MANGA_TRANSLATOR_USE_DRAFT") ??
      gemmaRuntimePreset.useDraft,
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
    llamaRuntimeProfile,
    ...(llamaRocmTarget ? { llamaRocmTarget } : {}),
    workingDir: paths.dataRoot,
    toolsDir: paths.toolsDir,
    serverPath:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_LLAMA_SERVER_PATH) ??
      resolveOptionalString(runtimeEnv.LLAMA_SERVER_PATH) ??
      resolveDefaultLlamaServerPathForGemma(
        paths,
        runtimeGemma,
        llamaRuntimeProfile,
        llamaRocmTarget ?? undefined,
      ),
    modelSource: runtimeGemma.modelSource,
    modelRepo:
      resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_MODEL_HF) ??
      runtimeGemma.modelRepo,
    modelFile:
      resolveOptionalString(runtimeEnv.LLAMA_ARG_HF_FILE) ??
      runtimeGemma.modelFile,
    mmprojRepo:
      runtimeGemma.modelSource === "huggingface"
        ? (resolveOptionalString(runtimeEnv.MANGA_TRANSLATOR_MMPROJ_HF) ??
          runtimeGemma.mmprojRepo ??
          getDefaultMmprojForGemmaModel(runtimeGemma)?.mmprojRepo)
        : undefined,
    mmprojFile:
      runtimeGemma.modelSource === "huggingface"
        ? (resolveOptionalString(runtimeEnv.LLAMA_ARG_MMPROJ_FILE) ??
          runtimeGemma.mmprojFile ??
          getDefaultMmprojForGemmaModel(runtimeGemma)?.mmprojFile)
        : undefined,
    localModelPath: runtimeGemma.localModelPath,
    localMmprojPath: runtimeGemma.localMmprojPath,
    codexModel: settings.codex.model,
    codexReasoningEffort: resolveCodexReasoningEffort(
      runtimeEnv.MANGA_TRANSLATOR_CODEX_REASONING_EFFORT,
      settings.codex.reasoningEffort,
    ),
    codexOauthPort: settings.codex.oauthPort,
    ocrDevice,
    ocrGpuBackend,
    ocrGpuCudaTag,
    ocrBboxProvider: resolveOptionalString(
      runtimeEnv.MANGA_TRANSLATOR_OCR_BBOX_PROVIDER,
    ),
    ocrBboxCommand: resolveOptionalString(
      runtimeEnv.MANGA_TRANSLATOR_OCR_BBOX_CMD,
    ),
    ocrBboxHintsPath: resolveOptionalString(
      runtimeEnv.MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH,
    ),
    ocrRuntimeDir: paths.ocrRuntimeDir,
    hfHomeDir: paths.hfHomeDir,
    hfHubCacheDir: paths.hfHubCacheDir,
    llamaCacheDir: paths.llamaCacheDir,
    label: `app-${jobId}`,
  };
}

export function filterPackagedRuntimeEnv(
  env: NodeJS.ProcessEnv,
  paths: Pick<TranslationOptionPaths, "isPackaged">,
): NodeJS.ProcessEnv {
  if (
    !paths.isPackaged ||
    readBooleanLikeEnv(
      env.MGT_ALLOW_EXTERNAL_RUNTIME ??
        env.MANGA_TRANSLATOR_ALLOW_EXTERNAL_RUNTIME,
    )
  ) {
    return env;
  }
  return {
    ...(env.MANGA_TRANSLATOR_AMD_ROCM_TARGET
      ? {
          MANGA_TRANSLATOR_AMD_ROCM_TARGET:
            env.MANGA_TRANSLATOR_AMD_ROCM_TARGET,
        }
      : {}),
    ...(env.MANGA_TRANSLATOR_AMD_GFX_ARCH
      ? { MANGA_TRANSLATOR_AMD_GFX_ARCH: env.MANGA_TRANSLATOR_AMD_GFX_ARCH }
      : {}),
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

function resolveRuntimeOcrDevice(
  env: NodeJS.ProcessEnv,
  configuredDevice: OcrDevice,
  llamaRuntimeProfile: LlamaRuntimeProfile,
  ocrGpuBackend: OcrGpuBackend,
): OcrDevice {
  const explicit =
    env.MANGA_TRANSLATOR_OCR_DEVICE ?? env.MANGA_TRANSLATOR_PADDLEOCR_DEVICE;
  if (explicit !== undefined) {
    return resolveOcrDevice(explicit, configuredDevice);
  }
  if (
    (isRocmLlamaRuntimeProfile(llamaRuntimeProfile) ||
      isVulkanLlamaRuntimeProfile(llamaRuntimeProfile)) &&
    ocrGpuBackend !== "rocm-transformers"
  ) {
    return "cpu";
  }
  return configuredDevice;
}

function resolveDefaultLlamaServerPathForGemma(
  paths: TranslationOptionPaths,
  gemma: AppSettings["gemma"],
  llamaRuntimeProfile = "cuda12",
  llamaRocmTarget?: string,
): string {
  if (
    gemma.modelSource !== "huggingface" ||
    !isBuiltInGemmaModel({
      modelRepo: gemma.modelRepo,
      modelFile: gemma.modelFile,
    })
  ) {
    return paths.llamaServerPath;
  }
  const binaryName =
    process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const useCuda13 = isRtx50LlamaRuntimeProfile(llamaRuntimeProfile);
  if (isRocmLlamaRuntimeProfile(llamaRuntimeProfile)) {
    const rocmTarget = normalizeAmdRocmTarget(llamaRocmTarget) ?? "unknown";
    return join(
      paths.dataRoot,
      "tools",
      `lemonade-llama-${LEMONADE_LLAMA_RUNTIME_ROCM_RELEASE}-rocm-${rocmTarget}`,
      binaryName,
    );
  }
  if (isVulkanLlamaRuntimeProfile(llamaRuntimeProfile)) {
    return join(
      paths.dataRoot,
      "tools",
      MAINLINE_LLAMA_RUNTIME_DIR_VULKAN,
      binaryName,
    );
  }
  const runtimeDir = isMainlineGemmaModel({
    modelRepo: gemma.modelRepo,
    modelFile: gemma.modelFile,
  })
    ? useCuda13
      ? MAINLINE_LLAMA_RUNTIME_DIR_CUDA13
      : MAINLINE_LLAMA_RUNTIME_DIR_CUDA12
    : useCuda13
      ? BEELLAMA_LLAMA_RUNTIME_DIR_CUDA13
      : BEELLAMA_LLAMA_RUNTIME_DIR_CUDA12;
  return join(paths.dataRoot, "tools", runtimeDir, binaryName);
}
