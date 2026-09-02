import { describe, it, expect } from "vitest";
import {
  resolveDefaultAppSettings,
  buildBaseTranslationOptions,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_GEMMA_MAX_TOKENS,
  DEFAULT_GEMMA_CONTEXT_TOKENS,
} from "../src/main/appSettings";
import type { AppSettings } from "../src/shared/settingsTypes";
import { join } from "node:path";
import {
  GEMMA_12B_QAT_MMPROJ_FILE,
  GEMMA_12B_QAT_MMPROJ_REPO,
  GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_12B_QAT_MODEL_REPO,
  GEMMA_12B_QAT_MTP_MODEL_FILE,
  GEMMA_12B_QAT_MTP_MODEL_REPO,
  GEMMA_26B_QAT_MMPROJ_FILE,
  GEMMA_26B_QAT_MMPROJ_REPO,
  GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_26B_QAT_MODEL_REPO,
  GEMMA_26B_QAT_MTP_MODEL_FILE,
  GEMMA_26B_QAT_MTP_MODEL_REPO,
  GEMMA_31B_QAT_MMPROJ_FILE,
  GEMMA_31B_QAT_MMPROJ_REPO,
  GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_31B_QAT_MODEL_REPO,
  GEMMA_31B_QAT_MTP_MODEL_FILE,
  GEMMA_31B_QAT_MTP_MODEL_REPO,
  GEMMA_MODEL_PRESETS,
} from "../src/shared/modelPresets";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("app settings helpers: packaged runtime profiles", () => {
  it("ignores packaged runtime environment overrides unless external runtime diagnostics are explicitly allowed", () => {
    const defaults = resolveDefaultAppSettings();
    const settings: AppSettings = {
      ...defaults,
      modelProvider: "gemma",
      gemma: {
        modelSource: "huggingface",
        modelRepo: "saved/repo",
        modelFile: "saved-model.gguf",
        vramMode: "economy26b",
      },
    };
    const paths = {
      isPackaged: true,
      dataRoot: "C:/app-data",
      toolsDir: "C:/app/resources/tools",
      ocrRuntimeDir: "C:/app-data/ocr-runtime",
      llamaServerPath: "C:/app/resources/tools/llama-server.exe",
      hfHomeDir: "C:/app-data/hf-cache",
      hfHubCacheDir: "C:/app-data/hf-cache/hub",
      llamaCacheDir: "C:/app-data/llama.cpp",
    };
    const env = {
      MANGA_TRANSLATOR_LLAMA_SERVER_PATH: "D:/external/llama-server.exe",
      MANGA_TRANSLATOR_MODEL_HF: "env/repo",
      LLAMA_ARG_HF_FILE: "env-model.gguf",
      MANGA_TRANSLATOR_CTX: "1234",
      MANGA_TRANSLATOR_OCR_BBOX_CMD: "external-ocr",
    } satisfies NodeJS.ProcessEnv;

    const blocked = buildBaseTranslationOptions({
      jobId: "packaged",
      runDir: "C:/app-data/runs/packaged",
      paths,
      settings,
      env,
    });
    const allowed = buildBaseTranslationOptions({
      jobId: "packaged",
      runDir: "C:/app-data/runs/packaged",
      paths,
      settings,
      env: { ...env, MGT_ALLOW_EXTERNAL_RUNTIME: "1" },
    });

    expect(blocked.serverPath).toBe(paths.llamaServerPath);
    expect(blocked.modelRepo).toBe("saved/repo");
    expect(blocked.modelFile).toBe("saved-model.gguf");
    expect(blocked.ctx).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(blocked.ocrBboxCommand).toBeUndefined();
    expect(blocked.llamaCacheDir).toBe(paths.llamaCacheDir);

    expect(allowed.serverPath).toBe("D:/external/llama-server.exe");
    expect(allowed.modelRepo).toBe("env/repo");
    expect(allowed.modelFile).toBe("env-model.gguf");
    expect(allowed.ctx).toBe(1234);
    expect(allowed.ocrBboxCommand).toBe("external-ocr");
  });

  it("still allows packaged AMD ROCm target overrides because they select bundled runtime folders", () => {
    const defaults = resolveDefaultAppSettings();
    const options = buildBaseTranslationOptions({
      jobId: "packaged-amd-target",
      runDir: "C:/app-data/runs/packaged-amd-target",
      paths: {
        isPackaged: true,
        dataRoot: "C:/app-data",
        toolsDir: "C:/app/resources/tools",
        ocrRuntimeDir: "C:/app-data/ocr-runtime",
        llamaServerPath: "C:/app/resources/tools/llama-server.exe",
        hfHomeDir: "C:/app-data/hf-cache",
        hfHubCacheDir: "C:/app-data/hf-cache/hub",
        llamaCacheDir: "C:/app-data/llama.cpp",
      },
      settings: {
        ...defaults,
        modelProvider: "gemma",
        gemma: {
          ...defaults.gemma,
          llamaRuntimeProfile: "rocm",
        },
      },
      env: {
        MANGA_TRANSLATOR_AMD_ROCM_TARGET: "gfx110X",
        MANGA_TRANSLATOR_LLAMA_SERVER_PATH: "D:/external/llama-server.exe",
      } satisfies NodeJS.ProcessEnv,
    });

    expect(options.llamaRuntimeProfile).toBe("rocm");
    expect(options.llamaRocmTarget).toBe("gfx110X");
    expect(options.serverPath).toBe(
      join(
        "C:/app-data",
        "tools",
        "lemonade-llama-b1317-rocm-gfx110X",
        "llama-server.exe",
      ),
    );
  });

  it("uses economy VRAM runtime options without clipping image tokens", () => {
    const defaults = resolveDefaultAppSettings();
    const options = buildBaseTranslationOptions({
      jobId: "job-economy",
      runDir: "C:/runs/job-economy",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: {
        ...defaults,
        modelProvider: "gemma",
        maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
        ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
        gemma: {
          ...defaults.gemma,
          ...GEMMA_MODEL_PRESETS.economy26b,
        },
        ocr: {
          ...defaults.ocr,
          qualityMode: "economy",
        },
      },
      env: {},
    });

    expect(options.gemmaVramMode).toBe("economy26b");
    expect(options.ctx).toBe(DEFAULT_GEMMA_CONTEXT_TOKENS);
    expect(options.batch).toBe(1024);
    expect(options.ubatch).toBe(1024);
    expect(options.cacheTypeK).toBe("q4_0");
    expect(options.cacheTypeV).toBe("q4_0");
    expect(options.ctxCheckpoints).toBe(0);
    expect(options.kvOffload).toBe(true);
    expect(options.mmprojOffload).toBe(true);
    expect(options.gpuLayers).toBe("fit");
    expect(options.enableMetrics).toBe(true);
    expect(options.enablePerf).toBe(true);
    expect(options.useDraft).toBe(false);
    expect(options.fitTargetMb).toBe(512);
    expect(options.ocrBboxMode).toBe("ocr");
    expect(options.ocrEngine).toBe("paddle_static");
    expect(options.ocrTextDetectionModelName).toBe("PP-OCRv6_small_det");
    expect(options.ocrTextRecognitionModelName).toBe("PP-OCRv6_small_rec");
    expect(options.ocrMergeMode).toBe("semantic");
    expect(options.imageMinTokens).toBe(1024);
    expect(options.imageMaxTokens).toBe(1024);
    expect(options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b9553-cuda12.4", "llama-server.exe"),
    );
  });

  it("uses a small detector and tiny recognizer for the minimum Gemma VRAM mode", () => {
    const defaults = resolveDefaultAppSettings();
    const options = buildBaseTranslationOptions({
      jobId: "job-minimum",
      runDir: "C:/runs/job-minimum",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: {
        ...defaults,
        gemma: {
          ...defaults.gemma,
          vramMode: "minimum12b",
        },
      },
      env: {},
    });

    expect(options.gemmaVramMode).toBe("minimum12b");
    expect(options.ocrBboxMode).toBe("ocr");
    expect(options.ocrEngine).toBe("paddle_static");
    expect(options.ocrTextDetectionModelName).toBe("PP-OCRv6_small_det");
    expect(options.ocrTextRecognitionModelName).toBe("PP-OCRv6_small_rec");
    expect(options.ocrMergeMode).toBe("semantic");
    expect(options.ocrDetLimit).toBe("1600");
    expect(options.ocrRecBatch).toBe("1");
  });

  it("enables draft-mtp automatically for the built-in QAT 12B preset", () => {
    const defaults = resolveDefaultAppSettings();
    const options = buildBaseTranslationOptions({
      jobId: "job-qat-mtp",
      runDir: "C:/runs/job-qat-mtp",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: {
        ...defaults,
        modelProvider: "gemma",
        gemma: {
          ...defaults.gemma,
          modelSource: "huggingface",
          modelRepo: GEMMA_12B_QAT_MODEL_REPO,
          modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
          mmprojRepo: GEMMA_12B_QAT_MMPROJ_REPO,
          mmprojFile: GEMMA_12B_QAT_MMPROJ_FILE,
          vramMode: "minimum12b",
          mmprojOffload: true,
        },
      },
      env: {},
    });

    expect(options.modelRepo).toBe(GEMMA_12B_QAT_MODEL_REPO);
    expect(options.modelFile).toBe(GEMMA_12B_QAT_MODEL_FILE_Q4_K_M);
    expect(options.mmprojRepo).toBe(GEMMA_12B_QAT_MMPROJ_REPO);
    expect(options.mmprojFile).toBe(GEMMA_12B_QAT_MMPROJ_FILE);
    expect(options.useDraft).toBe(true);
    expect(options.draftSpecType).toBe("draft-mtp");
    expect(options.draftModelRepo).toBe(GEMMA_12B_QAT_MTP_MODEL_REPO);
    expect(options.draftModelFile).toBe(GEMMA_12B_QAT_MTP_MODEL_FILE);
    expect(options.draftMaxTokens).toBe(8);
    expect(options.batch).toBe(1024);
    expect(options.ubatch).toBe(1024);
    expect(options.fitTargetMb).toBe(512);
    expect(options.gpuLayers).toBe("fit");
    expect(options.fitEnabled).toBeUndefined();
    expect(options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b10621-cuda12.4", "llama-server.exe"),
    );
  });

  it("enables draft-mtp automatically for the built-in QAT 26B preset", () => {
    const defaults = resolveDefaultAppSettings();
    const options = buildBaseTranslationOptions({
      jobId: "job-qat-26b-mtp",
      runDir: "C:/runs/job-qat-26b-mtp",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: {
        ...defaults,
        modelProvider: "gemma",
        maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
        ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
        runtimeHardware: {
          gpuVendor: "nvidia",
          gpuMemoryMb: 24_564,
        },
        gemma: {
          ...defaults.gemma,
          modelSource: "huggingface",
          modelRepo: GEMMA_26B_QAT_MODEL_REPO,
          modelFile: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
          mmprojRepo: GEMMA_26B_QAT_MMPROJ_REPO,
          mmprojFile: GEMMA_26B_QAT_MMPROJ_FILE,
          vramMode: "economy26b",
          mmprojOffload: true,
        },
      },
      env: {},
    });

    expect(options.modelRepo).toBe(GEMMA_26B_QAT_MODEL_REPO);
    expect(options.modelFile).toBe(GEMMA_26B_QAT_MODEL_FILE_Q4_K_M);
    expect(options.mmprojRepo).toBe(GEMMA_26B_QAT_MMPROJ_REPO);
    expect(options.mmprojFile).toBe(GEMMA_26B_QAT_MMPROJ_FILE);
    expect(options.useDraft).toBe(true);
    expect(options.draftSpecType).toBe("draft-mtp");
    expect(options.draftModelRepo).toBe(GEMMA_26B_QAT_MTP_MODEL_REPO);
    expect(options.draftModelFile).toBe(GEMMA_26B_QAT_MTP_MODEL_FILE);
    expect(options.draftMaxTokens).toBe(2);
    expect(options.batch).toBe(1024);
    expect(options.ubatch).toBe(1024);
    expect(options.fitTargetMb).toBe(512);
    expect(options.gpuLayers).toBe("fit");
    expect(options.fitEnabled).toBeUndefined();
    expect(options.gpuMemoryMb).toBe(24_564);
    expect(options.cacheTypeK).toBe("q4_0");
    expect(options.cacheTypeV).toBe("q4_0");
    expect(options.ctxCheckpoints).toBe(0);
    expect(options.kvOffload).toBe(true);
    expect(options.mmprojOffload).toBe(true);
    expect(options.disableMmap).toBe(true);
    expect(options.threads).toBe(10);
    expect(options.threadsBatch).toBe(12);
    expect(options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b10621-cuda12.4", "llama-server.exe"),
    );
  });

  it("enables draft-mtp automatically for the built-in QAT 31B speed preset", () => {
    const defaults = resolveDefaultAppSettings();
    const options = buildBaseTranslationOptions({
      jobId: "job-qat-31b-mtp",
      runDir: "C:/runs/job-qat-31b-mtp",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: {
        ...defaults,
        modelProvider: "gemma",
        maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
        ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
        runtimeHardware: {
          gpuVendor: "nvidia",
          gpuMemoryMb: 24_564,
        },
        gemma: {
          ...defaults.gemma,
          modelSource: "huggingface",
          modelRepo: GEMMA_31B_QAT_MODEL_REPO,
          modelFile: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
          mmprojRepo: GEMMA_31B_QAT_MMPROJ_REPO,
          mmprojFile: GEMMA_31B_QAT_MMPROJ_FILE,
          vramMode: "full31b",
          mmprojOffload: true,
        },
      },
      env: {},
    });

    expect(options.modelRepo).toBe(GEMMA_31B_QAT_MODEL_REPO);
    expect(options.modelFile).toBe(GEMMA_31B_QAT_MODEL_FILE_Q4_K_M);
    expect(options.mmprojRepo).toBe(GEMMA_31B_QAT_MMPROJ_REPO);
    expect(options.mmprojFile).toBe(GEMMA_31B_QAT_MMPROJ_FILE);
    expect(options.useDraft).toBe(true);
    expect(options.draftSpecType).toBe("draft-mtp");
    expect(options.draftModelRepo).toBe(GEMMA_31B_QAT_MTP_MODEL_REPO);
    expect(options.draftModelFile).toBe(GEMMA_31B_QAT_MTP_MODEL_FILE);
    expect(options.draftMaxTokens).toBe(2);
    expect(options.ctx).toBe(DEFAULT_GEMMA_CONTEXT_TOKENS);
    expect(options.batch).toBe(1024);
    expect(options.ubatch).toBe(1024);
    expect(options.fitTargetMb).toBe(512);
    expect(options.gpuLayers).toBe("fit");
    expect(options.fitEnabled).toBeUndefined();
    expect(options.cacheTypeK).toBe("q4_0");
    expect(options.cacheTypeV).toBe("q4_0");
    expect(options.disableMmap).toBe(true);
    expect(options.threads).toBe(10);
    expect(options.threadsBatch).toBe(12);
    expect(options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b10621-cuda12.4", "llama-server.exe"),
    );
  });

  it("uses the full VRAM smoke preset with DFlash draft enabled", () => {
    const defaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      },
    );
    const options = buildBaseTranslationOptions({
      jobId: "job-full",
      runDir: "C:/runs/job-full",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: {
        ...defaults,
        gemma: {
          ...defaults.gemma,
          ...GEMMA_MODEL_PRESETS.full31b,
          fitTargetMb: 1536,
        },
      },
      env: {},
    });

    expect(options.gemmaVramMode).toBe("full31b");
    expect(options.ctx).toBe(DEFAULT_GEMMA_CONTEXT_TOKENS);
    expect(options.batch).toBe(1024);
    expect(options.ubatch).toBe(1024);
    expect(options.cacheTypeK).toBe("q4_0");
    expect(options.cacheTypeV).toBe("q4_0");
    expect(options.ctxCheckpoints).toBe(0);
    expect(options.kvOffload).toBe(true);
    expect(options.mmprojOffload).toBe(true);
    expect(options.enableMetrics).toBe(true);
    expect(options.enablePerf).toBe(true);
    expect(options.useDraft).toBe(true);
    expect(options.draftModelRepo).toBeTruthy();
    expect(options.draftModelFile).toBeTruthy();
    expect(options.fitTargetMb).toBe(1536);
    expect(options.ocrPipeline).toBe("hayai");
    expect(options.ocrBboxProvider).toBe("hayai-regions");
    expect(options.ocrBboxMode).toBeUndefined();
    expect(options.ocrEngine).toBeUndefined();
    expect(options.llamaRuntimeProfile).toBe("cuda12");
    expect(options.serverPath).toBe(
      join(
        "C:/app-data",
        "tools",
        "beellama-v0.2.0-cuda12.4",
        "llama-server.exe",
      ),
    );
  });

  it("keeps Hayai runtime identity isolated from legacy Paddle overrides", () => {
    const defaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      },
    );
    const options = buildBaseTranslationOptions({
      jobId: "job-hayai-legacy-override-isolation",
      runDir: "C:/runs/hayai-legacy-override-isolation",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: {
        ...defaults,
        ocr: {
          ...defaults.ocr,
          pipeline: "hayai",
          device: "gpu",
          gpuBackend: "cuda",
          gpuCudaTag: "cu126",
          qualityMode: "full",
        },
      },
      env: {
        MANGA_TRANSLATOR_PADDLEOCR_DEVICE: "cpu",
        MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG: "cu999",
        MANGA_TRANSLATOR_PADDLEOCR_QUALITY_MODE: "economy",
        MANGA_TRANSLATOR_PADDLEOCR_ENGINE: "paddle_static",
        MANGA_TRANSLATOR_OCR_BBOX_PROVIDER: "paddleocr",
      },
    });

    expect(options).toMatchObject({
      ocrPipeline: "hayai",
      ocrDevice: "gpu",
      ocrGpuBackend: "cuda",
      ocrGpuCudaTag: "cu126",
      ocrQualityMode: "full",
      ocrBboxProvider: "hayai-regions",
    });
    expect(options.ocrEngine).toBeUndefined();
    expect(options.ocrBboxMode).toBeUndefined();
  });

  it("keeps legacy Paddle aliases scoped to the legacy pipeline", () => {
    const defaults = resolveDefaultAppSettings();
    const options = buildBaseTranslationOptions({
      jobId: "job-paddle-legacy-aliases",
      runDir: "C:/runs/paddle-legacy-aliases",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: {
        ...defaults,
        ocr: {
          ...defaults.ocr,
          pipeline: "paddle-legacy",
          device: "gpu",
          gpuBackend: "cuda",
          gpuCudaTag: "cu126",
          qualityMode: "full",
        },
      },
      env: {
        MANGA_TRANSLATOR_PADDLEOCR_DEVICE: "cpu",
        MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG: "cu129",
        MANGA_TRANSLATOR_PADDLEOCR_QUALITY_MODE: "economy",
        MANGA_TRANSLATOR_OCR_BBOX_PROVIDER: "hayai-regions",
      },
    });

    expect(options).toMatchObject({
      ocrPipeline: "paddle-legacy",
      ocrDevice: "cpu",
      ocrGpuCudaTag: "cu129",
      ocrQualityMode: "economy",
      ocrBboxProvider: "paddleocr",
      ocrEngine: "paddle_static",
    });
  });

  it("applies saved VRAM tuning without changing context or ubatch and disables MTP on CPU mmproj", () => {
    const defaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
        vendor: "nvidia",
      },
    );
    const options = buildBaseTranslationOptions({
      jobId: "job-full-mmproj-cpu",
      runDir: "C:/runs/job-full-mmproj-cpu",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: {
        ...defaults,
        gemma: {
          ...defaults.gemma,
          fitTargetMb: 512,
          mmprojOffload: false,
        },
      },
      env: {},
    });

    expect(options.fitTargetMb).toBe(512);
    expect(options.mmprojOffload).toBe(false);
    expect(options.useDraft).toBe(false);
    expect(options.ctx).toBe(DEFAULT_GEMMA_CONTEXT_TOKENS);
    expect(options.ubatch).toBe(1024);
  });

  it("keeps MTP off whenever KV is moved to CPU", () => {
    const defaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
        vendor: "nvidia",
      },
    );
    const options = buildBaseTranslationOptions({
      jobId: "job-full-kv-cpu",
      runDir: "C:/runs/job-full-kv-cpu",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: defaults,
      env: {
        MANGA_TRANSLATOR_KV_OFFLOAD: "false",
        MANGA_TRANSLATOR_USE_DRAFT: "true",
      },
    });

    expect(options.kvOffload).toBe(false);
    expect(options.useDraft).toBe(false);
  });

  it("migrates removed CUDA legacy quality values onto semantic full OCR", () => {
    const defaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      },
    );
    const options = buildBaseTranslationOptions({
      jobId: "job-legacy-quality-migration",
      runDir: "C:/runs/job-legacy-quality-migration",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: defaults,
      env: {
        MANGA_TRANSLATOR_OCR_PIPELINE: "paddle-legacy",
        MANGA_TRANSLATOR_OCR_QUALITY_MODE: "cuda-legacy-full",
        MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE: "vl",
        MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE: "legacy",
      },
    });

    expect(options.ocrQualityMode).toBe("full");
    expect(options.ocrBboxMode).toBe("ocr");
    expect(options.ocrEngine).toBe("transformers");
    expect(options.ocrVersion).toBe("PP-OCRv6");
    expect(options.ocrMergeMode).toBe("semantic");
    expect(options.ocrTextDetectionModelName).toBeUndefined();
    expect(options.ocrTextRecognitionModelName).toBeUndefined();
  });

  it("keeps common OCR qualities on the semantic OCR path despite legacy env values", () => {
    const defaults = resolveDefaultAppSettings();
    const paths = {
      dataRoot: "C:/app-data",
      toolsDir: "C:/tools",
      llamaServerPath: "C:/tools/llama-server.exe",
      hfHomeDir: "C:/hf-home",
      hfHubCacheDir: "C:/hf-home/hub",
    };
    const scenarios: Array<{
      label: string;
      ocr: AppSettings["ocr"];
      expectedQuality: "economy" | "full";
      expectedEngine: "paddle_static" | "transformers";
      expectedDetectionModel?: string;
      expectedRecognitionModel?: string;
    }> = [
      {
        label: "CPU full downgraded to economy",
        ocr: {
          ...defaults.ocr,
          device: "cpu",
          gpuBackend: "cuda",
          qualityMode: "full",
        },
        expectedQuality: "economy",
        expectedEngine: "paddle_static",
        expectedDetectionModel: "PP-OCRv6_small_det",
        expectedRecognitionModel: "PP-OCRv6_small_rec",
      },
      {
        label: "ROCm full",
        ocr: {
          ...defaults.ocr,
          device: "gpu",
          gpuBackend: "rocm-transformers",
          qualityMode: "full",
        },
        expectedQuality: "full",
        expectedEngine: "transformers",
      },
    ];

    for (const scenario of scenarios) {
      const options = buildBaseTranslationOptions({
        jobId: `job-ocr-boundary-${scenario.label}`,
        runDir: "C:/runs/ocr-boundary",
        paths,
        settings: { ...defaults, ocr: scenario.ocr },
        env: {
          MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE: "vl",
          MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE: "legacy",
        },
      });

      expect({
        quality: options.ocrQualityMode,
        bboxMode: options.ocrBboxMode,
        mergeMode: options.ocrMergeMode,
        engine: options.ocrEngine,
        detectionModel: options.ocrTextDetectionModelName,
        recognitionModel: options.ocrTextRecognitionModelName,
      }).toEqual({
        quality: scenario.expectedQuality,
        bboxMode: "ocr",
        mergeMode: "semantic",
        engine: scenario.expectedEngine,
        detectionModel: scenario.expectedDetectionModel,
        recognitionModel: scenario.expectedRecognitionModel,
      });
    }
  });
});
