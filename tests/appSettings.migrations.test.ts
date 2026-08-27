import { describe, it, expect } from "vitest";
import {
  resolveDefaultAppSettings,
  parseStoredAppSettings,
  resolveHardwareDefaults,
  DEFAULT_OCR_GPU_CUDA_TAG,
  RTX_50_OCR_GPU_CUDA_TAG,
  GEMMA_12B_MODEL_REPO,
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MMPROJ_REPO,
  GEMMA_12B_MMPROJ_FILE,
  DEFAULT_GEMMA_MAX_TOKENS,
  DEFAULT_GEMMA_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
} from "../src/main/appSettings";
import { CURRENT_GENERATION_LIMITS_VERSION } from "../src/main/settings/appSettingsGenerationLimitMigration";
import {
  GEMMA_12B_QAT_MMPROJ_FILE,
  GEMMA_12B_QAT_MMPROJ_REPO,
  GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_12B_QAT_MODEL_REPO,
  GEMMA_26B_QAT_MMPROJ_FILE,
  GEMMA_26B_QAT_MMPROJ_REPO,
  GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_26B_QAT_MODEL_REPO,
} from "../src/shared/modelPresets";
import {
  resolveOcrGpuBackend,
  resolveOcrQualityMode,
  resolveFluxBackend,
  resolveInpaintingModel,
  resolveKoharuInpaintingBackend,
} from "../src/main/settings/appSettingsResolvers";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("app settings helpers: UI settings and migrations", () => {
  it("persists UI settings such as hidden inpainting guide", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings('{"ui":{"inpaintingGuideHidden":true}}', defaults)
        .ui?.inpaintingGuideHidden,
    ).toBe(true);
    expect(
      parseStoredAppSettings('{"ui":{"inpaintingGuideHidden":"yes"}}', defaults)
        .ui?.inpaintingGuideHidden,
    ).toBe(false);
  });

  it("migrates missing and legacy translation workflow settings to cumulative", () => {
    const defaults = resolveDefaultAppSettings();

    expect(defaults.ui?.translationWorkflowDefault).toBe("cumulative");
    const migrated = parseStoredAppSettings(
      '{"ui":{"twoPassByDefault":true,"translationWorkflowDefault":"two-pass","analysisScopeDefault":"work"}}',
      defaults,
    ).ui;
    expect(migrated).toEqual(
      expect.objectContaining({ translationWorkflowDefault: "cumulative" }),
    );
    expect(migrated).not.toHaveProperty("twoPassByDefault");
    expect(migrated).not.toHaveProperty("analysisScopeDefault");
  });

  it("normalizes OCR device settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings('{"ocr":{"device":"gpu"}}', defaults).ocr.device,
    ).toBe("gpu");
    expect(
      parseStoredAppSettings('{"ocr":{"device":"gpu"}}', defaults).ocr
        .gpuCudaTag,
    ).toBe(defaults.ocr.gpuCudaTag);
    expect(
      parseStoredAppSettings(
        '{"ocr":{"device":"gpu","gpuCudaTag":"cu129"}}',
        defaults,
      ).ocr.gpuCudaTag,
    ).toBe("cu129");
    expect(
      parseStoredAppSettings('{"ocr":{"device":"tpu"}}', defaults).ocr.device,
    ).toBe(defaults.ocr.device);
    expect(
      resolveDefaultAppSettings({ MANGA_TRANSLATOR_OCR_DEVICE: "gpu" }).ocr
        .device,
    ).toBe("gpu");
    expect(
      resolveDefaultAppSettings({ MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG: "cu129" })
        .ocr.gpuCudaTag,
    ).toBe("cu129");
    const rtx50Defaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 5080",
        memoryMb: 16303,
        rtxGeneration: 50,
        computeCapability: 12,
      },
    );
    expect(
      parseStoredAppSettings(
        '{"ocr":{"device":"gpu","gpuCudaTag":"cu126"}}',
        rtx50Defaults,
      ).ocr.gpuCudaTag,
    ).toBe("cu129");
  });

  it("normalizes OCR GPU backend aliases", () => {
    expect(resolveOcrGpuBackend("cuda")).toBe("cuda");
    expect(resolveOcrGpuBackend("nvidia")).toBe("cuda");
    expect(resolveOcrGpuBackend("rocm")).toBe("rocm-transformers");
    expect(resolveOcrGpuBackend("amd")).toBe("rocm-transformers");
    expect(resolveOcrGpuBackend("hip")).toBe("rocm-transformers");
    expect(resolveOcrGpuBackend("rocm-transformers")).toBe("rocm-transformers");
    expect(resolveOcrGpuBackend("transformers-rocm")).toBe("rocm-transformers");
    expect(resolveOcrGpuBackend("mps", "rocm-transformers")).toBe(
      "rocm-transformers",
    );
    expect(resolveOcrQualityMode("min", "full")).toBe("economy");
    expect(resolveOcrQualityMode("tiny", "full")).toBe("economy");
    expect(resolveOcrQualityMode("small", "full")).toBe("economy");
    expect(resolveOcrQualityMode("full", "economy")).toBe("full");
    expect(resolveOcrQualityMode("vl", "economy")).toBe("full");
    expect(resolveOcrQualityMode("cuda-legacy", "economy")).toBe("full");
    expect(resolveOcrQualityMode("unknown", "economy")).toBe("economy");
  });

  it("normalizes inpainting model and Koharu backend aliases", () => {
    expect(resolveFluxBackend("apple")).toBe("metal-native");
    expect(resolveInpaintingModel("flux")).toBe("flux-klein");
    expect(resolveInpaintingModel("koharu")).toBe("lama-manga");
    expect(resolveInpaintingModel("lama_manga")).toBe("lama-manga");
    expect(resolveInpaintingModel("aot")).toBe("aot-inpainting");
    expect(resolveInpaintingModel("unknown", "aot-inpainting")).toBe(
      "aot-inpainting",
    );

    expect(resolveKoharuInpaintingBackend("default")).toBe("auto");
    expect(resolveKoharuInpaintingBackend("nvidia")).toBe("cuda-native");
    expect(resolveKoharuInpaintingBackend("amd")).toBe("zluda-native");
    expect(resolveKoharuInpaintingBackend("apple")).toBe("metal-native");
    expect(resolveKoharuInpaintingBackend("python-cpu")).toBe("cpu");
  });

  it("persists only an explicit low-memory Flux Alpha opt-in", () => {
    const defaults = resolveDefaultAppSettings();
    expect(
      parseStoredAppSettings(
        '{"inpainting":{"allowUnsafeLowMemoryFlux":true}}',
        defaults,
      ).inpainting?.allowUnsafeLowMemoryFlux,
    ).toBe(true);
    expect(
      parseStoredAppSettings(
        '{"inpainting":{"allowUnsafeLowMemoryFlux":"yes"}}',
        defaults,
      ).inpainting?.allowUnsafeLowMemoryFlux,
    ).toBe(false);
  });

  it("chooses first-run defaults from detected GPU generation and VRAM", () => {
    expect(
      resolveHardwareDefaults({
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      }),
    ).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "full31b",
      ocrDevice: "gpu",
      ocrQualityMode: "full",
      ocrGpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "cuda",
      fluxBackend: "cuda-native",
      llamaRuntimeProfile: "cuda12",
    });
    expect(
      resolveHardwareDefaults({
        name: "NVIDIA GeForce RTX 5070 Ti",
        memoryMb: 16303,
        rtxGeneration: 50,
        computeCapability: 12,
      }),
    ).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "economy26b",
      ocrDevice: "gpu",
      ocrQualityMode: "full",
      ocrGpuCudaTag: RTX_50_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "cuda",
      fluxBackend: "cuda-native",
      llamaRuntimeProfile: "rtx50",
    });
    expect(
      resolveHardwareDefaults({
        name: "NVIDIA GeForce RTX 5090",
        memoryMb: 32768,
        rtxGeneration: null,
        computeCapability: 12,
      }),
    ).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "full31b",
      ocrDevice: "gpu",
      ocrQualityMode: "full",
      ocrGpuCudaTag: RTX_50_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "cuda",
      fluxBackend: "cuda-native",
      llamaRuntimeProfile: "rtx50",
    });
    expect(
      resolveHardwareDefaults({
        name: "NVIDIA GeForce RTX 3060",
        memoryMb: 12288,
        rtxGeneration: 30,
        computeCapability: 8.6,
      }),
    ).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "minimum12b",
      ocrDevice: "gpu",
      ocrQualityMode: "full",
      ocrGpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "cuda",
      fluxBackend: "cuda-native",
      llamaRuntimeProfile: "cuda12",
    });
    expect(
      resolveHardwareDefaults({
        name: "NVIDIA GeForce RTX 2080 Ti",
        memoryMb: 11264,
        rtxGeneration: 20,
        computeCapability: 7.5,
      }),
    ).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "minimum12b",
      ocrDevice: "gpu",
      ocrQualityMode: "full",
      ocrGpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "cuda",
      fluxBackend: "cuda-sm75-experimental",
      llamaRuntimeProfile: "cuda12",
    });
    expect(
      resolveHardwareDefaults({
        name: "NVIDIA Quadro RTX 5000",
        memoryMb: 16384,
        rtxGeneration: null,
        computeCapability: 7.5,
      }),
    ).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "economy26b",
      ocrDevice: "gpu",
      ocrQualityMode: "full",
      ocrGpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "cuda",
      fluxBackend: "cuda-native",
      llamaRuntimeProfile: "cuda12",
    });
    expect(
      resolveHardwareDefaults({
        name: "AMD Radeon RX 7900 XTX",
        memoryMb: 24576,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      }),
    ).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "full31b",
      ocrDevice: "gpu",
      ocrQualityMode: "full",
      ocrGpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "rocm-transformers",
      fluxBackend: "zluda-native",
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
    });
    expect(
      resolveHardwareDefaults({
        name: "AMD Radeon RX 7800 XT",
        memoryMb: 16384,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: true,
      }),
    ).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "economy26b",
      ocrDevice: "gpu",
      ocrQualityMode: "full",
      ocrGpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "rocm-transformers",
      fluxBackend: "zluda-native",
      llamaRuntimeProfile: "rocm",
      llamaRocmTarget: "gfx110X",
    });
    expect(resolveHardwareDefaults(null)).toEqual({
      modelProvider: "openai-codex",
      gemmaVramMode: "minimum12b",
      ocrDevice: "cpu",
      ocrQualityMode: "economy",
      ocrGpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "cuda",
      fluxBackend: "cuda-native",
      llamaRuntimeProfile: "cuda12",
    });
  });

  it("normalizes Gemma VRAM mode settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings('{"gemma":{"vramMode":"economy"}}', defaults).gemma
        .vramMode,
    ).toBe("economy26b");
    expect(
      parseStoredAppSettings('{"gemma":{"vramMode":"full"}}', defaults).gemma
        .vramMode,
    ).toBe("full31b");
    expect(
      parseStoredAppSettings('{"gemma":{"vramMode":"12b"}}', defaults).gemma
        .vramMode,
    ).toBe("minimum12b");
    expect(
      parseStoredAppSettings('{"gemma":{"vramMode":"tiny"}}', defaults).gemma
        .vramMode,
    ).toBe(defaults.gemma.vramMode);
    expect(
      resolveDefaultAppSettings({ MANGA_TRANSLATOR_GEMMA_VRAM_MODE: "economy" })
        .gemma.vramMode,
    ).toBe("economy26b");
    expect(
      resolveDefaultAppSettings({ MANGA_TRANSLATOR_GEMMA_VRAM_MODE: "26b" })
        .gemma.vramMode,
    ).toBe("economy26b");
    expect(
      resolveDefaultAppSettings({ MANGA_TRANSLATOR_GEMMA_VRAM_MODE: "31b" })
        .gemma.vramMode,
    ).toBe("full31b");
    expect(
      resolveDefaultAppSettings({ MANGA_TRANSLATOR_GEMMA_VRAM_MODE: "min" })
        .gemma.vramMode,
    ).toBe("minimum12b");
  });

  it("preserves valid Gemma VRAM tuning and repairs invalid stored values", () => {
    const defaults = resolveDefaultAppSettings();
    const tuned = parseStoredAppSettings(
      JSON.stringify({
        gemma: { fitTargetMb: 512, mmprojOffload: false },
      }),
      defaults,
    );
    const repaired = parseStoredAppSettings(
      JSON.stringify({
        gemma: { fitTargetMb: 512.5, mmprojOffload: "cpu" },
      }),
      defaults,
    );

    expect(tuned.gemma.fitTargetMb).toBe(512);
    expect(tuned.gemma.mmprojOffload).toBe(false);
    expect(repaired.gemma.fitTargetMb).toBe(defaults.gemma.fitTargetMb);
    expect(repaired.gemma.mmprojOffload).toBe(defaults.gemma.mmprojOffload);
  });

  it("migrates the legacy lowercase 12B mmproj filename", () => {
    const defaults = resolveDefaultAppSettings();
    const restored = parseStoredAppSettings(
      JSON.stringify({
        gemma: {
          modelSource: "huggingface",
          modelRepo: GEMMA_12B_MODEL_REPO,
          modelFile: GEMMA_12B_MODEL_FILE_Q4_K_M,
          mmprojRepo: GEMMA_12B_MMPROJ_REPO,
          mmprojFile: "mmproj-gemma-4-12B-it-bf16.gguf",
          vramMode: "minimum12b",
        },
      }),
      defaults,
    );

    expect(restored.gemma.mmprojRepo).toBe(GEMMA_12B_MMPROJ_REPO);
    expect(restored.gemma.mmprojFile).toBe(GEMMA_12B_MMPROJ_FILE);
  });

  it("preserves the QAT 12B model instead of rewriting it by VRAM mode", () => {
    const defaults = resolveDefaultAppSettings();
    const restored = parseStoredAppSettings(
      JSON.stringify({
        gemma: {
          modelSource: "huggingface",
          modelRepo: GEMMA_12B_QAT_MODEL_REPO,
          modelFile: GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
          mmprojRepo: GEMMA_12B_QAT_MMPROJ_REPO,
          mmprojFile: GEMMA_12B_QAT_MMPROJ_FILE,
          vramMode: "minimum12b",
        },
      }),
      defaults,
    );

    expect(restored.gemma.modelRepo).toBe(GEMMA_12B_QAT_MODEL_REPO);
    expect(restored.gemma.modelFile).toBe(GEMMA_12B_QAT_MODEL_FILE_Q4_K_M);
    expect(restored.gemma.mmprojRepo).toBe(GEMMA_12B_QAT_MMPROJ_REPO);
    expect(restored.gemma.mmprojFile).toBe(GEMMA_12B_QAT_MMPROJ_FILE);
  });

  it("preserves the QAT 26B model instead of rewriting it by VRAM mode", () => {
    const defaults = resolveDefaultAppSettings();
    const restored = parseStoredAppSettings(
      JSON.stringify({
        gemma: {
          modelSource: "huggingface",
          modelRepo: GEMMA_26B_QAT_MODEL_REPO,
          modelFile: GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
          mmprojRepo: GEMMA_26B_QAT_MMPROJ_REPO,
          mmprojFile: GEMMA_26B_QAT_MMPROJ_FILE,
          vramMode: "economy26b",
        },
      }),
      defaults,
    );

    expect(restored.gemma.modelRepo).toBe(GEMMA_26B_QAT_MODEL_REPO);
    expect(restored.gemma.modelFile).toBe(GEMMA_26B_QAT_MODEL_FILE_Q4_K_M);
    expect(restored.gemma.mmprojRepo).toBe(GEMMA_26B_QAT_MMPROJ_REPO);
    expect(restored.gemma.mmprojFile).toBe(GEMMA_26B_QAT_MMPROJ_FILE);
  });

  it("normalizes max token settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings('{"maxTokens":1200}', defaults).maxTokens,
    ).toBe(1200);
    expect(
      parseStoredAppSettings('{"maxTokens":100}', defaults).maxTokens,
    ).toBe(300);
    expect(
      parseStoredAppSettings('{"maxTokens":9000}', defaults).maxTokens,
    ).toBe(9000);
    expect(
      parseStoredAppSettings('{"maxTokens":16000}', defaults).maxTokens,
    ).toBe(16000);
    expect(
      parseStoredAppSettings('{"maxTokens":40000}', defaults).maxTokens,
    ).toBe(40000);
    expect(
      parseStoredAppSettings('{"maxTokens":200000}', defaults).maxTokens,
    ).toBe(128000);
    expect(
      parseStoredAppSettings('{"maxTokens":"bad"}', defaults).maxTokens,
    ).toBe(defaults.maxTokens);
  });

  it("uses the saved provider and model for missing generation limits", () => {
    const defaults = resolveDefaultAppSettings();
    const gemma = parseStoredAppSettings('{"modelProvider":"gemma"}', defaults);
    const spark = parseStoredAppSettings(
      JSON.stringify({
        modelProvider: "openai-codex",
        codex: { model: "gpt-5.3-codex-spark" },
      }),
      defaults,
    );

    expect(gemma.maxTokens).toBe(DEFAULT_GEMMA_MAX_TOKENS);
    expect(gemma.ctx).toBe(DEFAULT_GEMMA_CONTEXT_TOKENS);
    expect(spark.maxTokens).toBe(24576);
    expect(spark.ctx).toBe(65536);
  });

  it("preserves explicit generation limits across provider changes", () => {
    const defaults = resolveDefaultAppSettings();
    const stored = parseStoredAppSettings(
      JSON.stringify({
        modelProvider: "gemma",
        maxTokens: 20000,
        ctx: 45000,
      }),
      defaults,
    );

    expect(stored.maxTokens).toBe(20000);
    expect(stored.ctx).toBe(45000);
  });

  it("migrates only the paired legacy remote defaults to model-aware limits", () => {
    const defaults = resolveDefaultAppSettings();
    const codex = parseStoredAppSettings(
      JSON.stringify({
        modelProvider: "openai-codex",
        codex: { model: "gpt-5.6-sol" },
        maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
        ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
      }),
      defaults,
    );
    const gemini = parseStoredAppSettings(
      JSON.stringify({
        modelProvider: "openai-api",
        api: { model: "gemini-3.5-flash-lite" },
        maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
        ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
      }),
      defaults,
    );

    expect(codex.maxTokens).toBe(32768);
    expect(codex.ctx).toBe(65536);
    expect(gemini.maxTokens).toBe(65536);
    expect(gemini.ctx).toBe(524288);
  });

  it("preserves custom, local, and versioned generation limits", () => {
    const defaults = resolveDefaultAppSettings();
    const parse = (settings: Record<string, unknown>) =>
      parseStoredAppSettings(JSON.stringify(settings), defaults);

    expect(
      parse({
        modelProvider: "openai-api",
        api: { model: "gemini-3.5-flash-lite" },
        maxTokens: 12001,
        ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
      }),
    ).toMatchObject({ maxTokens: 12001, ctx: DEFAULT_GEMMA_CONTEXT_TOKENS });
    expect(
      parse({
        modelProvider: "openai-api",
        api: { model: "gemini-3.5-flash-lite" },
        maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
        ctx: 20000,
      }),
    ).toMatchObject({ maxTokens: DEFAULT_GEMMA_MAX_TOKENS, ctx: 20000 });
    expect(
      parse({
        modelProvider: "gemma",
        maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
        ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
      }),
    ).toMatchObject({
      maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
      ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
    });
    expect(
      parse({
        generationLimitsVersion: CURRENT_GENERATION_LIMITS_VERSION,
        modelProvider: "openai-api",
        api: { model: "gemini-3.5-flash-lite" },
        maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
        ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
      }),
    ).toMatchObject({
      maxTokens: DEFAULT_GEMMA_MAX_TOKENS,
      ctx: DEFAULT_GEMMA_CONTEXT_TOKENS,
    });
  });

  it("normalizes context length settings without an upper cap", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{}", defaults).ctx).toBe(
      DEFAULT_CONTEXT_TOKENS,
    );
    expect(parseStoredAppSettings('{"ctx":8192}', defaults).ctx).toBe(8192);
    expect(parseStoredAppSettings('{"ctx":512}', defaults).ctx).toBe(1024);
    expect(parseStoredAppSettings('{"ctx":131072}', defaults).ctx).toBe(131072);
    expect(parseStoredAppSettings('{"ctx":"bad"}', defaults).ctx).toBe(
      defaults.ctx,
    );
    expect(
      resolveDefaultAppSettings({ MANGA_TRANSLATOR_CTX: "32768" }).ctx,
    ).toBe(32768);
  });

  it("maps the old Codex minimal value to low", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          modelProvider: "openai-codex",
          codex: {
            reasoningEffort: "minimal",
          },
        }),
        defaults,
      ).codex.reasoningEffort,
    ).toBe("low");
  });
});
