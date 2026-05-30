import { describe, expect, it } from "vitest";
import {
  buildBaseTranslationOptions,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_OAUTH_PORT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_GEMMA_GPU_LAYERS,
  DEFAULT_GEMMA_MMPROJ_FILE,
  DEFAULT_GEMMA_MMPROJ_REPO,
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_REPO,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OCR_DEVICE,
  parseStoredAppSettings,
  resolveHardwareDefaults,
  resolveDefaultAppSettings
} from "../src/main/appSettings";
import type { AppSettings } from "../src/shared/types";

describe("app settings helpers", () => {
  it("uses Codex as the hardware-safe fallback when GPU detection is unavailable", () => {
    const defaults = resolveDefaultAppSettings();

    expect(defaults.gemma.modelRepo).toBe(DEFAULT_GEMMA_MODEL_REPO);
    expect(defaults.gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE);
    expect(defaults.gemma.mmprojRepo).toBe(DEFAULT_GEMMA_MMPROJ_REPO);
    expect(defaults.gemma.mmprojFile).toBe(DEFAULT_GEMMA_MMPROJ_FILE);
    expect(defaults.gemma.gpuLayers).toBe(DEFAULT_GEMMA_GPU_LAYERS);
    expect(defaults.modelProvider).toBe("openai-codex");
    expect(defaults.gemma.vramMode).toBe("economy");
    expect(defaults.codex.model).toBe(DEFAULT_CODEX_MODEL);
    expect(defaults.codex.reasoningEffort).toBe(DEFAULT_CODEX_REASONING_EFFORT);
    expect(defaults.codex.oauthPort).toBe(DEFAULT_CODEX_OAUTH_PORT);
    expect(defaults.ocr.device).toBe(DEFAULT_OCR_DEVICE);
    expect(defaults.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("uses hardware-based provider and VRAM mode defaults when no override is provided", () => {
    expect(resolveDefaultAppSettings({}, 12000).gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE);
    expect(resolveDefaultAppSettings({}, 24564).gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE);
    expect(resolveDefaultAppSettings({}, 32768).gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE);
    expect(resolveDefaultAppSettings({}, { name: "NVIDIA GeForce RTX 4090", memoryMb: 24564, rtxGeneration: 40 }).modelProvider).toBe("gemma");
    expect(resolveDefaultAppSettings({}, { name: "NVIDIA GeForce RTX 4090", memoryMb: 24564, rtxGeneration: 40 }).gemma.vramMode).toBe("full");
    expect(resolveDefaultAppSettings({}, { name: "NVIDIA GeForce RTX 5070 Ti", memoryMb: 16303, rtxGeneration: 50 }).modelProvider).toBe("gemma");
    expect(resolveDefaultAppSettings({}, { name: "NVIDIA GeForce RTX 5070 Ti", memoryMb: 16303, rtxGeneration: 50 }).gemma.vramMode).toBe("economy");
  });

  it("fills missing or partial stored settings from environment-based defaults", () => {
    const env = {
      MANGA_TRANSLATOR_MODEL_HF: "env/default-repo",
      LLAMA_ARG_HF_FILE: "env-default.gguf",
      MANGA_TRANSLATOR_GPU_LAYERS: "12"
    } satisfies NodeJS.ProcessEnv;
    const defaults = resolveDefaultAppSettings(env);

    expect(parseStoredAppSettings("", defaults)).toEqual(defaults);
    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"custom/repo\"}}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "huggingface",
        modelRepo: "custom/repo",
        modelFile: "env-default.gguf",
        gpuLayers: 12,
        vramMode: defaults.gemma.vramMode
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      maxTokens: defaults.maxTokens
    });
  });

  it("clamps out-of-range stored gpu layers and falls back on invalid values", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"repo\",\"modelFile\":\"file.gguf\",\"gpuLayers\":31}}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "huggingface",
        modelRepo: "repo",
        modelFile: "file.gguf",
        gpuLayers: 30,
        vramMode: defaults.gemma.vramMode
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      maxTokens: defaults.maxTokens
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"repo\",\"modelFile\":\"file.gguf\",\"gpuLayers\":99}}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "huggingface",
        modelRepo: "repo",
        modelFile: "file.gguf",
        gpuLayers: 30,
        vramMode: defaults.gemma.vramMode
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      maxTokens: defaults.maxTokens
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"repo\",\"modelFile\":\"file.gguf\",\"gpuLayers\":-1}}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "huggingface",
        modelRepo: "repo",
        modelFile: "file.gguf",
        gpuLayers: 0,
        vramMode: defaults.gemma.vramMode
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      maxTokens: defaults.maxTokens
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"gpuLayers\":\"abc\"}}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "huggingface",
        modelRepo: defaults.gemma.modelRepo,
        modelFile: defaults.gemma.modelFile,
        mmprojRepo: defaults.gemma.mmprojRepo,
        mmprojFile: defaults.gemma.mmprojFile,
        gpuLayers: DEFAULT_GEMMA_GPU_LAYERS,
        vramMode: defaults.gemma.vramMode
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      maxTokens: defaults.maxTokens
    });
  });

  it("ignores legacy stored translation mode values", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"translationMode\":\"accuracy\"}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: defaults.gemma,
      codex: defaults.codex,
      ocr: defaults.ocr,
      maxTokens: defaults.maxTokens
    });

    expect(parseStoredAppSettings("{\"translationMode\":\"turbo\"}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: defaults.gemma,
      codex: defaults.codex,
      ocr: defaults.ocr,
      maxTokens: defaults.maxTokens
    });
  });

  it("builds translation options from saved model settings while preserving other defaults", () => {
    const settings: AppSettings = {
      modelProvider: "gemma",
      gemma: {
        modelSource: "huggingface",
        modelRepo: "saved/repo",
        modelFile: "saved-model.gguf",
        gpuLayers: 24,
        vramMode: "economy"
      },
      codex: {
        model: DEFAULT_CODEX_MODEL,
        reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
        oauthPort: DEFAULT_CODEX_OAUTH_PORT
      },
      ocr: {
        device: "gpu"
      },
      maxTokens: DEFAULT_MAX_TOKENS
    };

    const options = buildBaseTranslationOptions({
      jobId: "job-1",
      runDir: "C:/runs/job-1",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub"
      },
      settings,
      env: {
        MANGA_TRANSLATOR_TEMPERATURE: "0.2",
        MANGA_TRANSLATOR_CTX: "8192",
        MANGA_TRANSLATOR_GPU_LAYERS: "4"
      } satisfies NodeJS.ProcessEnv
    });

    expect(options.modelRepo).toBe("saved/repo");
    expect(options.modelFile).toBe("saved-model.gguf");
    expect(options.modelProvider).toBe("gemma");
    expect(options.codexModel).toBe(DEFAULT_CODEX_MODEL);
    expect(options.codexReasoningEffort).toBe(DEFAULT_CODEX_REASONING_EFFORT);
    expect(options.codexOauthPort).toBe(DEFAULT_CODEX_OAUTH_PORT);
    expect(options.ocrDevice).toBe("gpu");
    expect(options.gpuLayers).toBe(24);
    expect(options.gemmaVramMode).toBe("economy");
    expect(options.cacheTypeK).toBe("q4_0");
    expect(options.cacheTypeV).toBe("q4_0");
    expect(options.ctxCheckpoints).toBe(0);
    expect(options.kvOffload).toBe(true);
    expect(options.mmprojOffload).toBe(false);
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
    expect(options.fitTargetMb).toBe(1024);
    expect(options.workingDir).toBe("C:/app-data");
    expect(options.outputDir).toBe("C:/runs/job-1");
    expect(options.label).toBe("app-job-1");
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
        hfHubCacheDir: "C:/hf-home/hub"
      },
      settings: {
        ...defaults,
        gemma: {
          ...defaults.gemma,
          vramMode: "economy"
        }
      },
      env: {}
    });

    expect(options.gemmaVramMode).toBe("economy");
    expect(options.ctx).toBe(8192);
    expect(options.batch).toBe(1024);
    expect(options.ubatch).toBe(1024);
    expect(options.cacheTypeK).toBe("q4_0");
    expect(options.cacheTypeV).toBe("q4_0");
    expect(options.ctxCheckpoints).toBe(0);
    expect(options.kvOffload).toBe(true);
    expect(options.mmprojOffload).toBe(false);
    expect(options.enableMetrics).toBe(true);
    expect(options.enablePerf).toBe(true);
    expect(options.useDraft).toBe(false);
    expect(options.fitTargetMb).toBe(1024);
    expect(options.imageMinTokens).toBe(1024);
    expect(options.imageMaxTokens).toBe(1024);
  });

  it("uses the full VRAM smoke preset with DFlash draft enabled", () => {
    const defaults = resolveDefaultAppSettings({}, { name: "NVIDIA GeForce RTX 4090", memoryMb: 24564, rtxGeneration: 40 });
    const options = buildBaseTranslationOptions({
      jobId: "job-full",
      runDir: "C:/runs/job-full",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
        hfHomeDir: "C:/hf-home",
        hfHubCacheDir: "C:/hf-home/hub"
      },
      settings: defaults,
      env: {}
    });

    expect(options.gemmaVramMode).toBe("full");
    expect(options.ctx).toBe(16384);
    expect(options.batch).toBe(2048);
    expect(options.ubatch).toBe(1536);
    expect(options.cacheTypeK).toBe("q4_0");
    expect(options.cacheTypeV).toBe("q4_0");
    expect(options.ctxCheckpoints).toBe(0);
    expect(options.mmprojOffload).toBe(false);
    expect(options.enableMetrics).toBe(true);
    expect(options.enablePerf).toBe(true);
    expect(options.useDraft).toBe(true);
    expect(options.draftModelRepo).toBeTruthy();
    expect(options.draftModelFile).toBeTruthy();
  });

  it("keeps local model settings when the source is local", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          gemma: {
            modelSource: "local",
            localModelPath: "D:/models/custom-vision-model.gguf",
            localMmprojPath: "D:/models/mmproj.gguf"
          }
        }),
        defaults
      )
    ).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "local",
        modelRepo: defaults.gemma.modelRepo,
        modelFile: defaults.gemma.modelFile,
        localModelPath: "D:/models/custom-vision-model.gguf",
        localMmprojPath: "D:/models/mmproj.gguf",
        gpuLayers: defaults.gemma.gpuLayers,
        vramMode: defaults.gemma.vramMode
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      maxTokens: defaults.maxTokens
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
            oauthPort: 10532
          }
        }),
        defaults
      )
    ).toEqual({
      modelProvider: "openai-codex",
      gemma: defaults.gemma,
      codex: {
        model: "gpt-5.5",
        reasoningEffort: "xhigh",
        oauthPort: 10532
      },
      ocr: defaults.ocr,
      maxTokens: defaults.maxTokens
    });
  });

  it("normalizes OCR device settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"ocr\":{\"device\":\"gpu\"}}", defaults).ocr.device).toBe("gpu");
    expect(parseStoredAppSettings("{\"ocr\":{\"device\":\"tpu\"}}", defaults).ocr.device).toBe(defaults.ocr.device);
    expect(resolveDefaultAppSettings({ MANGA_TRANSLATOR_OCR_DEVICE: "gpu" }).ocr.device).toBe("gpu");
  });

  it("chooses first-run defaults from detected GPU generation and VRAM", () => {
    expect(resolveHardwareDefaults({ name: "NVIDIA GeForce RTX 4090", memoryMb: 24564, rtxGeneration: 40 })).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "full",
      ocrDevice: "gpu"
    });
    expect(resolveHardwareDefaults({ name: "NVIDIA GeForce RTX 5070 Ti", memoryMb: 16303, rtxGeneration: 50 })).toEqual({
      modelProvider: "gemma",
      gemmaVramMode: "economy",
      ocrDevice: "gpu"
    });
    expect(resolveHardwareDefaults({ name: "NVIDIA GeForce RTX 3060", memoryMb: 12288, rtxGeneration: 30 })).toEqual({
      modelProvider: "openai-codex",
      gemmaVramMode: "economy",
      ocrDevice: "gpu"
    });
    expect(resolveHardwareDefaults({ name: "NVIDIA GeForce RTX 2080 Ti", memoryMb: 11264, rtxGeneration: 20 })).toEqual({
      modelProvider: "openai-codex",
      gemmaVramMode: "economy",
      ocrDevice: "cpu"
    });
    expect(resolveHardwareDefaults(null)).toEqual({
      modelProvider: "openai-codex",
      gemmaVramMode: "economy",
      ocrDevice: "cpu"
    });
  });

  it("normalizes Gemma VRAM mode settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"gemma\":{\"vramMode\":\"economy\"}}", defaults).gemma.vramMode).toBe("economy");
    expect(parseStoredAppSettings("{\"gemma\":{\"vramMode\":\"tiny\"}}", defaults).gemma.vramMode).toBe(
      defaults.gemma.vramMode
    );
    expect(resolveDefaultAppSettings({ MANGA_TRANSLATOR_GEMMA_VRAM_MODE: "economy" }).gemma.vramMode).toBe("economy");
  });

  it("normalizes max token settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"maxTokens\":1200}", defaults).maxTokens).toBe(1200);
    expect(parseStoredAppSettings("{\"maxTokens\":100}", defaults).maxTokens).toBe(300);
    expect(parseStoredAppSettings("{\"maxTokens\":9000}", defaults).maxTokens).toBe(9000);
    expect(parseStoredAppSettings("{\"maxTokens\":16000}", defaults).maxTokens).toBe(12000);
    expect(parseStoredAppSettings("{\"maxTokens\":\"bad\"}", defaults).maxTokens).toBe(defaults.maxTokens);
  });

  it("maps the old Codex minimal value to low", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          modelProvider: "openai-codex",
          codex: {
            reasoningEffort: "minimal"
          }
        }),
        defaults
      ).codex.reasoningEffort
    ).toBe("low");
  });
});
