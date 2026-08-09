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
        "lemonade-llama-b1291-rocm-gfx110X",
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
          vramMode: "economy26b",
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
    expect(options.fitTargetMb).toBe(2048);
    expect(options.ocrBboxMode).toBe("ocr");
    expect(options.ocrEngine).toBe("paddle_static");
    expect(options.ocrTextDetectionModelName).toBe("PP-OCRv6_small_det");
    expect(options.ocrTextRecognitionModelName).toBe("PP-OCRv6_small_rec");
    expect(options.ocrMergeMode).toBe("semantic");
    expect(options.imageMinTokens).toBe(1024);
    expect(options.imageMaxTokens).toBe(1024);
    expect(options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b9547-cuda12.4", "llama-server.exe"),
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
      settings: defaults,
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
    expect(options.fitTargetMb).toBe(1024);
    expect(options.ocrBboxMode).toBe("ocr");
    expect(options.ocrEngine).toBe("transformers");
    expect(options.ocrEngineDtype).toBe("float32");
    expect(options.ocrVersion).toBe("PP-OCRv6");
    expect(options.ocrTextDetectionModelName).toBeUndefined();
    expect(options.ocrTextRecognitionModelName).toBeUndefined();
    expect(options.ocrMergeMode).toBe("semantic");
    expect(options.ocrDetLimit).toBe("1600");
    expect(options.ocrRecBatch).toBe("1");
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
      expectedQuality: "minimum" | "economy" | "full";
      expectedEngine: "paddle_static" | "transformers";
      expectedDetectionModel?: string;
      expectedRecognitionModel?: string;
    }> = [
      {
        label: "CUDA minimum",
        ocr: {
          ...defaults.ocr,
          device: "gpu",
          gpuBackend: "cuda",
          qualityMode: "minimum",
        },
        expectedQuality: "minimum",
        expectedEngine: "paddle_static",
        expectedDetectionModel: "PP-OCRv6_small_det",
        expectedRecognitionModel: "PP-OCRv6_small_rec",
      },
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
