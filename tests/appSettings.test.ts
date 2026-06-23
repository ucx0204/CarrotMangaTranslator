import { describe, expect, it } from "vitest";
import {
  buildBaseTranslationOptions,
  DEFAULT_API_BASE_URL,
  DEFAULT_API_CUSTOM_HEADERS_JSON,
  DEFAULT_API_EXTRA_BODY_JSON,
  DEFAULT_API_MODEL,
  DEFAULT_API_REASONING_EFFORT,
  DEFAULT_API_TEMPERATURE,
  DEFAULT_API_TOP_K,
  DEFAULT_API_TOP_P,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_OAUTH_PORT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OCR_DEVICE,
  DEFAULT_OCR_GPU_CUDA_TAG,
  GEMMA_12B_MMPROJ_FILE,
  GEMMA_12B_MMPROJ_REPO,
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MODEL_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  GEMMA_26B_MODEL_REPO,
  parseStoredAppSettings,
  resolveHardwareDefaults,
  resolveDefaultAppSettings,
  RTX_50_OCR_GPU_CUDA_TAG,
} from "../src/main/appSettings";
import {
  resolveInpaintingModel,
  resolveKoharuInpaintingBackend,
  resolveOcrGpuBackend,
} from "../src/main/settings/appSettingsResolvers";
import type { AppSettings } from "../src/shared/types";
import { join } from "node:path";

describe("app settings helpers", () => {
  it("uses Codex as the hardware-safe fallback when GPU detection is unavailable", () => {
    const defaults = resolveDefaultAppSettings();

    expect(defaults.gemma.modelRepo).toBe(GEMMA_12B_MODEL_REPO);
    expect(defaults.gemma.modelFile).toBe(GEMMA_12B_MODEL_FILE_Q4_K_M);
    expect(defaults.gemma.mmprojRepo).toBe(GEMMA_12B_MMPROJ_REPO);
    expect(defaults.gemma.mmprojFile).toBe(GEMMA_12B_MMPROJ_FILE);
    expect(defaults.modelProvider).toBe("openai-codex");
    expect(defaults.gemma.vramMode).toBe("minimum12b");
    expect(defaults.codex.model).toBe(DEFAULT_CODEX_MODEL);
    expect(defaults.codex.reasoningEffort).toBe(DEFAULT_CODEX_REASONING_EFFORT);
    expect(defaults.codex.oauthPort).toBe(DEFAULT_CODEX_OAUTH_PORT);
    expect(defaults.api.baseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(defaults.api.model).toBe(DEFAULT_API_MODEL);
    expect(defaults.api.apiKey).toBeUndefined();
    expect(defaults.api.temperature).toBe(DEFAULT_API_TEMPERATURE);
    expect(defaults.api.topP).toBe(DEFAULT_API_TOP_P);
    expect(defaults.api.topK).toBe(DEFAULT_API_TOP_K);
    expect(defaults.api.reasoningEffort).toBe(DEFAULT_API_REASONING_EFFORT);
    expect(defaults.api.extraBodyJson).toBe(DEFAULT_API_EXTRA_BODY_JSON);
    expect(defaults.api.customHeadersJson).toBe(
      DEFAULT_API_CUSTOM_HEADERS_JSON,
    );
    expect(defaults.ocr.device).toBe(DEFAULT_OCR_DEVICE);
    expect(defaults.ocr.gpuCudaTag).toBe(DEFAULT_OCR_GPU_CUDA_TAG);
    expect(defaults.inpainting?.model).toBe("flux-klein");
    expect(defaults.inpainting?.koharuBackend).toBe("auto");
    expect(defaults.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(defaults.ctx).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("uses hardware-based provider and VRAM mode defaults when no override is provided", () => {
    expect(resolveDefaultAppSettings({}, 12000).modelProvider).toBe(
      "openai-codex",
    );
    expect(resolveDefaultAppSettings({}, 12000).gemma.modelFile).toBe(
      GEMMA_12B_MODEL_FILE_Q4_K_M,
    );
    expect(resolveDefaultAppSettings({}, 24564).modelProvider).toBe(
      "openai-codex",
    );
    expect(resolveDefaultAppSettings({}, 32768).gemma.modelFile).toBe(
      GEMMA_12B_MODEL_FILE_Q4_K_M,
    );
    const rtx4090Defaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      },
    );
    expect(rtx4090Defaults.modelProvider).toBe("gemma");
    expect(rtx4090Defaults.gemma.vramMode).toBe("full31b");
    expect(rtx4090Defaults.gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE);
    const rtx5070Defaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 5070 Ti",
        memoryMb: 16303,
        rtxGeneration: 50,
        computeCapability: 12,
      },
    );
    expect(rtx5070Defaults.modelProvider).toBe("gemma");
    expect(rtx5070Defaults.gemma.vramMode).toBe("economy26b");
    expect(rtx5070Defaults.gemma.modelRepo).toBe(GEMMA_26B_MODEL_REPO);
    expect(rtx5070Defaults.gemma.modelFile).toBe(GEMMA_26B_MODEL_FILE_IQ3_S);
    expect(rtx5070Defaults.ocr.gpuCudaTag).toBe(RTX_50_OCR_GPU_CUDA_TAG);
  });

  it("fills missing or partial stored settings from environment-based defaults", () => {
    const env = {
      MANGA_TRANSLATOR_MODEL_HF: "env/default-repo",
      LLAMA_ARG_HF_FILE: "env-default.gguf",
    } satisfies NodeJS.ProcessEnv;
    const defaults = resolveDefaultAppSettings(env);

    expect(parseStoredAppSettings("", defaults)).toEqual(defaults);
    expect(
      parseStoredAppSettings('{"gemma":{"modelRepo":"custom/repo"}}', defaults),
    ).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "huggingface",
        modelRepo: "custom/repo",
        modelFile: "env-default.gguf",
        vramMode: defaults.gemma.vramMode,
        llamaRuntimeProfile: defaults.gemma.llamaRuntimeProfile,
      },
      codex: defaults.codex,
      api: defaults.api,
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });
  });

  it("throws on malformed stored settings so the settings store can back it up", () => {
    const defaults = resolveDefaultAppSettings();

    expect(() => parseStoredAppSettings("{ malformed", defaults)).toThrow(
      SyntaxError,
    );
  });

  it("ignores legacy stored translation mode values", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings('{"translationMode":"accuracy"}', defaults),
    ).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: defaults.gemma,
      codex: defaults.codex,
      api: defaults.api,
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });

    expect(
      parseStoredAppSettings('{"translationMode":"turbo"}', defaults),
    ).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: defaults.gemma,
      codex: defaults.codex,
      api: defaults.api,
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });
  });

  it("builds translation options from saved model settings while preserving other defaults", () => {
    const settings: AppSettings = {
      modelProvider: "gemma",
      gemma: {
        modelSource: "huggingface",
        modelRepo: "saved/repo",
        modelFile: "saved-model.gguf",
        vramMode: "economy26b",
      },
      codex: {
        model: DEFAULT_CODEX_MODEL,
        reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
        oauthPort: DEFAULT_CODEX_OAUTH_PORT,
      },
      api: {
        baseUrl: "https://api.openai.com/v1",
        model: DEFAULT_CODEX_MODEL,
      },
      ocr: {
        device: "gpu",
        gpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      },
      maxTokens: DEFAULT_MAX_TOKENS,
      ctx: DEFAULT_CONTEXT_TOKENS,
    };

    const options = buildBaseTranslationOptions({
      jobId: "job-1",
      runDir: "C:/runs/job-1",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings,
      env: {
        MANGA_TRANSLATOR_TEMPERATURE: "0.2",
        MANGA_TRANSLATOR_CTX: "8192",
      } satisfies NodeJS.ProcessEnv,
    });

    expect(options.modelRepo).toBe("saved/repo");
    expect(options.modelFile).toBe("saved-model.gguf");
    expect(options.modelProvider).toBe("gemma");
    expect(options.codexModel).toBe(DEFAULT_CODEX_MODEL);
    expect(options.codexReasoningEffort).toBe(DEFAULT_CODEX_REASONING_EFFORT);
    expect(options.codexOauthPort).toBe(DEFAULT_CODEX_OAUTH_PORT);
    expect(options.apiBaseUrl).toBe("https://api.openai.com/v1");
    expect(options.apiModel).toBe(DEFAULT_CODEX_MODEL);
    expect(options.apiKey).toBeUndefined();
    expect(options.ocrDevice).toBe("gpu");
    expect(options.ocrGpuCudaTag).toBe(DEFAULT_OCR_GPU_CUDA_TAG);
    expect(options.gemmaVramMode).toBe("economy26b");
    expect(options.cacheTypeK).toBe("q4_0");
    expect(options.cacheTypeV).toBe("q4_0");
    expect(options.ctxCheckpoints).toBe(0);
    expect(options.kvOffload).toBe(true);
    expect(options.mmprojOffload).toBe(true);
    expect(options.gpuLayers).toBe("fit");
    expect(options.enableMetrics).toBe(true);
    expect(options.enablePerf).toBe(true);
    expect(options.useDraft).toBe(false);
    expect(options.mmprojRepo).toBeUndefined();
    expect(options.mmprojFile).toBeUndefined();
    expect(options.temperature).toBe(0.2);
    expect(options.ctx).toBe(8192);
    expect(options.batch).toBe(1024);
    expect(options.ubatch).toBe(1024);
    expect(options.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(options.imageMinTokens).toBe(1024);
    expect(options.imageMaxTokens).toBe(1024);
    expect(options.includeEnhancedVariant).toBe(false);
    expect(options.topP).toBe(0.95);
    expect(options.topK).toBe(64);
    expect(options.fitTargetMb).toBe(2048);
    expect(options.workingDir).toBe("C:/app-data");
    expect(options.outputDir).toBe("C:/runs/job-1");
    expect(options.label).toBe("app-job-1");
  });

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
        gemma: {
          ...defaults.gemma,
          vramMode: "economy26b",
        },
      },
      env: {},
    });

    expect(options.gemmaVramMode).toBe("economy26b");
    expect(options.ctx).toBe(DEFAULT_CONTEXT_TOKENS);
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
    expect(options.imageMinTokens).toBe(1024);
    expect(options.imageMaxTokens).toBe(1024);
    expect(options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b9547-cuda12.4", "llama-server.exe"),
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
      settings: defaults,
      env: {},
    });

    expect(options.gemmaVramMode).toBe("full31b");
    expect(options.ctx).toBe(DEFAULT_CONTEXT_TOKENS);
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

  it("routes RTX 50 series Gemma runtimes to CUDA 13 builds", () => {
    const rtx50EconomyDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 5070 Ti",
        memoryMb: 16303,
        rtxGeneration: 50,
        computeCapability: 12,
      },
    );
    const economyOptions = buildBaseTranslationOptions({
      jobId: "job-rtx50-economy",
      runDir: "C:/runs/job-rtx50-economy",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: rtx50EconomyDefaults,
      env: {},
    });

    expect(economyOptions.llamaRuntimeProfile).toBe("rtx50");
    expect(economyOptions.ocrGpuCudaTag).toBe(RTX_50_OCR_GPU_CUDA_TAG);
    expect(economyOptions.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b9547-cuda13.3", "llama-server.exe"),
    );

    const rtx50FullDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 5090",
        memoryMb: 32607,
        rtxGeneration: 50,
        computeCapability: 12,
      },
    );
    const fullOptions = buildBaseTranslationOptions({
      jobId: "job-rtx50-full",
      runDir: "C:/runs/job-rtx50-full",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: rtx50FullDefaults,
      env: {},
    });

    expect(fullOptions.llamaRuntimeProfile).toBe("rtx50");
    expect(fullOptions.serverPath).toBe(
      join(
        "C:/app-data",
        "tools",
        "beellama-v0.2.0-cuda13.1",
        "llama-server.exe",
      ),
    );
  });

  it("routes known AMD GPUs to Lemonade ROCm runtime targets", () => {
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon RX 7900 XTX",
        memoryMb: 24576,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: false,
      },
    );
    const options = buildBaseTranslationOptions({
      jobId: "job-amd-rocm",
      runDir: "C:/runs/job-amd-rocm",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: amdDefaults,
      env: {},
    });

    expect(amdDefaults.gemma.llamaRuntimeProfile).toBe("rocm");
    expect(amdDefaults.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(options.llamaRuntimeProfile).toBe("rocm");
    expect(options.llamaRocmTarget).toBe("gfx110X");
    expect(options.ocrDevice).toBe("gpu");
    expect(options.ocrGpuBackend).toBe("rocm-transformers");
    expect(options.serverPath).toBe(
      join(
        "C:/app-data",
        "tools",
        "lemonade-llama-b1291-rocm-gfx110X",
        "llama-server.exe",
      ),
    );
  });

  it("routes Azure Radeon PRO V710 to the AMD ROCm Gemma profile", () => {
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon PRO V710",
        memoryMb: 28672,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        rocmArch: null,
        supportsVulkan: true,
        supportsRocm: false,
      },
    );

    expect(amdDefaults.modelProvider).toBe("gemma");
    expect(amdDefaults.gemma.llamaRuntimeProfile).toBe("rocm");
    expect(amdDefaults.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(amdDefaults.ocr.device).toBe("gpu");
    expect(amdDefaults.ocr.gpuBackend).toBe("rocm-transformers");
  });

  it("restores the AMD ROCm target when old saved settings only kept the ROCm profile", () => {
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon PRO V710 MxGPU",
        memoryMb: 28672,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: true,
      },
    );
    const restored = parseStoredAppSettings(
      JSON.stringify({
        modelProvider: "gemma",
        gemma: {
          llamaRuntimeProfile: "rocm",
          vramMode: "minimum12b",
        },
      }),
      amdDefaults,
    );
    const options = buildBaseTranslationOptions({
      jobId: "job-amd-v710-restored",
      runDir: "C:/runs/job-amd-v710-restored",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: restored,
      env: {},
    });

    expect(restored.gemma.llamaRuntimeProfile).toBe("rocm");
    expect(restored.gemma.llamaRocmTarget).toBe("gfx110X");
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

  it("coerces saved runtime backends that do not match the detected GPU vendor", () => {
    const amdDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "AMD Radeon PRO V710",
        memoryMb: 28672,
        rtxGeneration: null,
        computeCapability: null,
        vendor: "amd",
        supportsVulkan: true,
        supportsRocm: true,
      },
    );
    const nvidiaDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 4090",
        memoryMb: 24564,
        rtxGeneration: 40,
        computeCapability: 8.9,
      },
    );

    const amdNormalized = parseStoredAppSettings(
      JSON.stringify({
        gemma: {
          llamaRuntimeProfile: "cuda12",
        },
        ocr: {
          device: "gpu",
        },
        inpainting: {
          fluxBackend: "cuda-native",
        },
      }),
      amdDefaults,
    );
    const nvidiaNormalized = parseStoredAppSettings(
      JSON.stringify({
        gemma: {
          llamaRuntimeProfile: "rocm",
          llamaRocmTarget: "gfx110X",
        },
        inpainting: {
          fluxBackend: "python-rocm",
        },
      }),
      nvidiaDefaults,
    );

    expect(amdNormalized.gemma.llamaRuntimeProfile).toBe("rocm");
    expect(amdNormalized.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(amdNormalized.ocr.device).toBe("gpu");
    expect(amdNormalized.inpainting?.fluxBackend).toBe(
      amdDefaults.inpainting?.fluxBackend,
    );
    expect(nvidiaNormalized.gemma.llamaRuntimeProfile).toBe("cuda12");
    expect(nvidiaNormalized.inpainting?.fluxBackend).toBe("cuda-native");
  });

  it("forces OCR to CPU for AMD llama runtimes when CUDA OCR is configured", () => {
    const defaults = resolveDefaultAppSettings();
    const settings: AppSettings = {
      ...defaults,
      modelProvider: "gemma",
      gemma: {
        ...defaults.gemma,
        llamaRuntimeProfile: "rocm",
      },
      ocr: {
        device: "gpu",
        gpuBackend: "cuda",
        gpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      },
    };

    const options = buildBaseTranslationOptions({
      jobId: "job-amd-ocr-cpu",
      runDir: "C:/runs/job-amd-ocr-cpu",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings,
      env: {},
    });

    expect(options.llamaRuntimeProfile).toBe("rocm");
    expect(options.ocrDevice).toBe("cpu");
    expect(options.ocrGpuBackend).toBe("cuda");
  });

  it("allows OCR GPU for AMD llama runtimes with the ROCm Transformers backend", () => {
    const defaults = resolveDefaultAppSettings();
    const settings: AppSettings = {
      ...defaults,
      modelProvider: "gemma",
      gemma: {
        ...defaults.gemma,
        llamaRuntimeProfile: "rocm",
      },
      ocr: {
        device: "gpu",
        gpuBackend: "rocm-transformers",
        gpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      },
    };

    const options = buildBaseTranslationOptions({
      jobId: "job-amd-ocr-rocm",
      runDir: "C:/runs/job-amd-ocr-rocm",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings,
      env: {},
    });

    expect(options.llamaRuntimeProfile).toBe("rocm");
    expect(options.ocrDevice).toBe("gpu");
    expect(options.ocrGpuBackend).toBe("rocm-transformers");
  });

  it("keeps Paddle OCR CUDA tag separate from the llama runtime profile", () => {
    const defaults = resolveDefaultAppSettings();
    const paths = {
      dataRoot: "C:/app-data",
      toolsDir: "C:/tools",
      llamaServerPath: "C:/tools/llama-server.exe",
      hfHomeDir: "C:/hf-home",
      hfHubCacheDir: "C:/hf-home/hub",
    };
    const settings: AppSettings = {
      ...defaults,
      modelProvider: "gemma",
      gemma: {
        ...defaults.gemma,
        llamaRuntimeProfile: "cuda12",
      },
      ocr: {
        device: "gpu",
        gpuCudaTag: RTX_50_OCR_GPU_CUDA_TAG,
      },
    };

    const cuda12Options = buildBaseTranslationOptions({
      jobId: "job-ocr-cu129-llama-cuda12",
      runDir: "C:/runs/job-ocr-cu129-llama-cuda12",
      paths,
      settings,
      env: {},
    });
    const rtx50Options = buildBaseTranslationOptions({
      jobId: "job-ocr-cu129-llama-rtx50",
      runDir: "C:/runs/job-ocr-cu129-llama-rtx50",
      paths,
      settings,
      env: {
        MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE: "rtx50",
      },
    });

    expect(cuda12Options.ocrGpuCudaTag).toBe(RTX_50_OCR_GPU_CUDA_TAG);
    expect(cuda12Options.llamaRuntimeProfile).toBe("cuda12");
    expect(cuda12Options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b9547-cuda12.4", "llama-server.exe"),
    );
    expect(rtx50Options.ocrGpuCudaTag).toBe(RTX_50_OCR_GPU_CUDA_TAG);
    expect(rtx50Options.llamaRuntimeProfile).toBe("rtx50");
    expect(rtx50Options.serverPath).toBe(
      join("C:/app-data", "tools", "llama-b9547-cuda13.3", "llama-server.exe"),
    );
  });

  it("canonicalizes llama runtime profile aliases before settings can be saved", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        '{"gemma":{"llamaRuntimeProfile":"cuda13.1"}}',
        defaults,
      ).gemma.llamaRuntimeProfile,
    ).toBe("rtx50");
    expect(
      parseStoredAppSettings(
        '{"gemma":{"llamaRuntimeProfile":"blackwell"}}',
        defaults,
      ).gemma.llamaRuntimeProfile,
    ).toBe("rtx50");

    const options = buildBaseTranslationOptions({
      jobId: "job-rtx50-alias",
      runDir: "C:/runs/job-rtx50-alias",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub",
      },
      settings: defaults,
      env: {
        MANGA_TRANSLATOR_LLAMA_RUNTIME_PROFILE: "cuda13.1",
      },
    });

    expect(options.llamaRuntimeProfile).toBe("rtx50");
  });

  it("keeps local model settings when the source is local", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          gemma: {
            modelSource: "local",
            localModelPath: "D:/models/custom-vision-model.gguf",
            localMmprojPath: "D:/models/mmproj.gguf",
          },
        }),
        defaults,
      ),
    ).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "local",
        modelRepo: defaults.gemma.modelRepo,
        modelFile: defaults.gemma.modelFile,
        localModelPath: "D:/models/custom-vision-model.gguf",
        localMmprojPath: "D:/models/mmproj.gguf",
        vramMode: defaults.gemma.vramMode,
        llamaRuntimeProfile: defaults.gemma.llamaRuntimeProfile,
      },
      codex: defaults.codex,
      api: defaults.api,
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });
  });

  it("normalizes Codex provider settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          modelProvider: "openai-codex",
          codex: {
            model: "gpt-5.5",
            reasoningEffort: "xhigh",
            oauthPort: 10532,
          },
        }),
        defaults,
      ),
    ).toEqual({
      modelProvider: "openai-codex",
      gemma: defaults.gemma,
      codex: {
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        oauthPort: 10532,
      },
      api: defaults.api,
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });
  });

  it("normalizes API provider settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          modelProvider: "openai-api",
          api: {
            baseUrl: "http://127.0.0.1:1234/v1/chat/completions/",
            model: "local-vision-model",
            apiKey: "sk-test",
          },
        }),
        defaults,
      ),
    ).toEqual({
      modelProvider: "openai-api",
      gemma: defaults.gemma,
      codex: defaults.codex,
      api: {
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "local-vision-model",
        apiKey: "sk-test",
        temperature: DEFAULT_API_TEMPERATURE,
        topP: DEFAULT_API_TOP_P,
        topK: DEFAULT_API_TOP_K,
        reasoningEffort: DEFAULT_API_REASONING_EFFORT,
        extraBodyJson: DEFAULT_API_EXTRA_BODY_JSON,
        customHeadersJson: DEFAULT_API_CUSTOM_HEADERS_JSON,
      },
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          modelProvider: "openai-api",
          api: {
            baseUrl: "ftp://example.test/v1",
            model: "",
          },
        }),
        defaults,
      ).api,
    ).toEqual(defaults.api);
  });

  it("applies API runtime environment overrides", () => {
    const defaults = resolveDefaultAppSettings();
    const options = buildBaseTranslationOptions({
      jobId: "job-api",
      runDir: "C:/runs/job-api",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: {
        ...defaults,
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://api.openai.com/v1",
          model: "saved-model",
          apiKey: "saved-key",
        },
      },
      env: {
        MANGA_TRANSLATOR_API_BASE_URL:
          "http://127.0.0.1:1234/v1/chat/completions",
        MANGA_TRANSLATOR_API_MODEL: "env-model",
        OPENAI_API_KEY: "env-key",
      } satisfies NodeJS.ProcessEnv,
    });

    expect(options.modelProvider).toBe("openai-api");
    expect(options.apiBaseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(options.apiModel).toBe("env-model");
    expect(options.apiKey).toBe("saved-key");
  });

  it("normalizes and preserves API advanced settings", () => {
    const defaults = resolveDefaultAppSettings();
    const stored = parseStoredAppSettings(
      JSON.stringify({
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://openrouter.ai/api/v1",
          model: "vision/model",
          temperature: null,
          topP: null,
          topK: 2048,
          reasoningEffort: "minimal",
          extraBodyJson: '{"provider":{"sort":"throughput"}}',
          customHeadersJson: '{"X-OpenRouter-Title":"Manga Translator"}',
        },
      }),
      defaults,
    );

    expect(stored.api.temperature).toBeNull();
    expect(stored.api.topP).toBeNull();
    expect(stored.api.topK).toBe(1000);
    expect(stored.api.reasoningEffort).toBe("minimal");
    expect(stored.api.extraBodyJson).toBe('{"provider":{"sort":"throughput"}}');
    expect(stored.api.customHeadersJson).toBe(
      '{"X-OpenRouter-Title":"Manga Translator"}',
    );

    const options = buildBaseTranslationOptions({
      jobId: "job-api-advanced",
      runDir: "C:/runs/job-api-advanced",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: stored,
      env: {
        MANGA_TRANSLATOR_API_TEMPERATURE: "",
        MANGA_TRANSLATOR_API_TOP_K: "5",
        MANGA_TRANSLATOR_API_REASONING_EFFORT: "high",
        MANGA_TRANSLATOR_API_EXTRA_BODY: '{"top_k":1}',
        MANGA_TRANSLATOR_API_HEADERS: '{"X-Test":"yes"}',
      } satisfies NodeJS.ProcessEnv,
    });

    expect(options.apiTemperature).toBeNull();
    expect(options.apiTopP).toBeNull();
    expect(options.apiTopK).toBe(5);
    expect(options.apiReasoningEffort).toBe("high");
    expect(options.apiExtraBodyJson).toBe('{"top_k":1}');
    expect(options.apiCustomHeadersJson).toBe('{"X-Test":"yes"}');
  });

  it("uses OPENAI_API_KEY only when API settings target the official endpoint", () => {
    const defaults = resolveDefaultAppSettings();
    const officialOptions = buildBaseTranslationOptions({
      jobId: "job-api-openai",
      runDir: "C:/runs/job-api-openai",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: {
        ...defaults,
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.5",
        },
      },
      env: {
        OPENAI_API_KEY: "openai-env-key",
      } satisfies NodeJS.ProcessEnv,
    });
    const compatibleOptions = buildBaseTranslationOptions({
      jobId: "job-api-compatible",
      runDir: "C:/runs/job-api-compatible",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: {
        ...defaults,
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://integrate.api.nvidia.com/v1",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
        },
      },
      env: {
        OPENAI_API_KEY: "openai-env-key",
      } satisfies NodeJS.ProcessEnv,
    });
    const explicitCompatibleOptions = buildBaseTranslationOptions({
      jobId: "job-api-compatible-explicit",
      runDir: "C:/runs/job-api-compatible-explicit",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings: {
        ...defaults,
        modelProvider: "openai-api",
        api: {
          baseUrl: "https://integrate.api.nvidia.com/v1",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          apiKey: "saved-provider-key",
        },
      },
      env: {
        MANGA_TRANSLATOR_API_KEY: "provider-env-key",
        OPENAI_API_KEY: "openai-env-key",
      } satisfies NodeJS.ProcessEnv,
    });

    expect(officialOptions.apiKey).toBe("openai-env-key");
    expect(compatibleOptions.apiKey).toBeUndefined();
    expect(explicitCompatibleOptions.apiKey).toBe("provider-env-key");
  });

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
  });

  it("normalizes inpainting model and Koharu backend aliases", () => {
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
    expect(resolveKoharuInpaintingBackend("python-cpu")).toBe("cpu");
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
      ocrGpuCudaTag: DEFAULT_OCR_GPU_CUDA_TAG,
      ocrGpuBackend: "cuda",
      fluxBackend: "cuda-native",
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
    ).toBe(32768);
    expect(
      parseStoredAppSettings('{"maxTokens":"bad"}', defaults).maxTokens,
    ).toBe(defaults.maxTokens);
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
