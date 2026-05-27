import { describe, expect, it } from "vitest";
import {
  buildBaseTranslationOptions,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_OAUTH_PORT,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_GEMMA_GPU_LAYERS,
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MODEL_FILE_Q3,
  DEFAULT_GEMMA_MODEL_FILE_Q6,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OCR_DEVICE,
  parseStoredAppSettings,
  resolveRecommendedModelFile,
  resolveDefaultAppSettings
} from "../src/main/appSettings";
import type { AppSettings } from "../src/shared/types";

describe("app settings helpers", () => {
  it("uses Q4_K_XL and 30 as built-in defaults", () => {
    const defaults = resolveDefaultAppSettings();

    expect(defaults.gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE);
    expect(defaults.gemma.gpuLayers).toBe(DEFAULT_GEMMA_GPU_LAYERS);
    expect(defaults.codex.model).toBe(DEFAULT_CODEX_MODEL);
    expect(defaults.codex.reasoningEffort).toBe(DEFAULT_CODEX_REASONING_EFFORT);
    expect(defaults.codex.oauthPort).toBe(DEFAULT_CODEX_OAUTH_PORT);
    expect(defaults.ocr.device).toBe(DEFAULT_OCR_DEVICE);
    expect(defaults.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("recommends model files from detected VRAM tiers", () => {
    expect(resolveRecommendedModelFile(12000)).toBe(DEFAULT_GEMMA_MODEL_FILE_Q3);
    expect(resolveRecommendedModelFile(16384)).toBe(DEFAULT_GEMMA_MODEL_FILE_Q3);
    expect(resolveRecommendedModelFile(24564)).toBe(DEFAULT_GEMMA_MODEL_FILE);
    expect(resolveRecommendedModelFile(32768)).toBe(DEFAULT_GEMMA_MODEL_FILE_Q6);
    expect(resolveRecommendedModelFile(null)).toBe(DEFAULT_GEMMA_MODEL_FILE);
  });

  it("uses the VRAM-based default model when no override is provided", () => {
    expect(resolveDefaultAppSettings({}, 12000).gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE_Q3);
    expect(resolveDefaultAppSettings({}, 24564).gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE);
    expect(resolveDefaultAppSettings({}, 32768).gemma.modelFile).toBe(DEFAULT_GEMMA_MODEL_FILE_Q6);
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
        gpuLayers: 12
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      nsfwMode: false,
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
        gpuLayers: 30
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      nsfwMode: false,
      maxTokens: defaults.maxTokens
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"repo\",\"modelFile\":\"file.gguf\",\"gpuLayers\":99}}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "huggingface",
        modelRepo: "repo",
        modelFile: "file.gguf",
        gpuLayers: 30
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      nsfwMode: false,
      maxTokens: defaults.maxTokens
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"modelRepo\":\"repo\",\"modelFile\":\"file.gguf\",\"gpuLayers\":-1}}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "huggingface",
        modelRepo: "repo",
        modelFile: "file.gguf",
        gpuLayers: 0
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      nsfwMode: false,
      maxTokens: defaults.maxTokens
    });

    expect(parseStoredAppSettings("{\"gemma\":{\"gpuLayers\":\"abc\"}}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: {
        modelSource: "huggingface",
        modelRepo: defaults.gemma.modelRepo,
        modelFile: defaults.gemma.modelFile,
        gpuLayers: DEFAULT_GEMMA_GPU_LAYERS
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      nsfwMode: false,
      maxTokens: defaults.maxTokens
    });
  });

  it("normalizes nsfw mode from stored settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"nsfwMode\":true}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: defaults.gemma,
      codex: defaults.codex,
      ocr: defaults.ocr,
      nsfwMode: true,
      maxTokens: defaults.maxTokens
    });

    expect(parseStoredAppSettings("{\"nsfwMode\":\"off\"}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: defaults.gemma,
      codex: defaults.codex,
      ocr: defaults.ocr,
      nsfwMode: false,
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
      nsfwMode: false,
      maxTokens: defaults.maxTokens
    });

    expect(parseStoredAppSettings("{\"translationMode\":\"turbo\"}", defaults)).toEqual({
      modelProvider: defaults.modelProvider,
      gemma: defaults.gemma,
      codex: defaults.codex,
      ocr: defaults.ocr,
      nsfwMode: false,
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
        gpuLayers: 24
      },
      codex: {
        model: DEFAULT_CODEX_MODEL,
        reasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
        oauthPort: DEFAULT_CODEX_OAUTH_PORT
      },
      ocr: {
        device: "gpu"
      },
      nsfwMode: true,
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
    expect(options.nsfwMode).toBe(true);
    expect(options.temperature).toBe(0.2);
    expect(options.ctx).toBe(8192);
    expect(options.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(options.imageMinTokens).toBe(640);
    expect(options.imageMaxTokens).toBe(640);
    expect(options.includeEnhancedVariant).toBe(false);
    expect(options.topP).toBe(0.85);
    expect(options.fitTargetMb).toBe(4096);
    expect(options.workingDir).toBe("C:/app-data");
    expect(options.outputDir).toBe("C:/runs/job-1");
    expect(options.label).toBe("app-job-1");
  });

  it("keeps local model settings when the source is local", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          gemma: {
            modelSource: "local",
            localModelPath: "D:/models/supergemma-q4.gguf",
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
        localModelPath: "D:/models/supergemma-q4.gguf",
        localMmprojPath: "D:/models/mmproj.gguf",
        gpuLayers: defaults.gemma.gpuLayers
      },
      codex: defaults.codex,
      ocr: defaults.ocr,
      nsfwMode: false,
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
      nsfwMode: false,
      maxTokens: defaults.maxTokens
    });
  });

  it("normalizes OCR device settings", () => {
    const defaults = resolveDefaultAppSettings();

    expect(parseStoredAppSettings("{\"ocr\":{\"device\":\"gpu\"}}", defaults).ocr.device).toBe("gpu");
    expect(parseStoredAppSettings("{\"ocr\":{\"device\":\"tpu\"}}", defaults).ocr.device).toBe(defaults.ocr.device);
    expect(resolveDefaultAppSettings({ MANGA_TRANSLATOR_OCR_DEVICE: "gpu" }).ocr.device).toBe("gpu");
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
