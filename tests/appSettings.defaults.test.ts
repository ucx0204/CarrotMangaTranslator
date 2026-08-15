import { describe, it, expect } from "vitest";
import {
  resolveDefaultAppSettings,
  GEMMA_12B_MODEL_REPO,
  GEMMA_12B_MODEL_FILE_Q4_K_M,
  GEMMA_12B_MMPROJ_REPO,
  GEMMA_12B_MMPROJ_FILE,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_OAUTH_PORT,
  DEFAULT_API_BASE_URL,
  DEFAULT_API_MODEL,
  DEFAULT_API_TEMPERATURE,
  DEFAULT_API_TOP_P,
  DEFAULT_API_TOP_K,
  DEFAULT_API_REASONING_EFFORT,
  DEFAULT_API_EXTRA_BODY_JSON,
  DEFAULT_API_CUSTOM_HEADERS_JSON,
  DEFAULT_OCR_DEVICE,
  DEFAULT_OCR_QUALITY_MODE,
  DEFAULT_OCR_GPU_CUDA_TAG,
  DEFAULT_MAX_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  parseStoredAppSettings,
  DEFAULT_GEMMA_MODEL_FILE,
  DEFAULT_GEMMA_MAX_TOKENS,
  DEFAULT_GEMMA_CONTEXT_TOKENS,
  GEMMA_26B_MODEL_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  RTX_50_OCR_GPU_CUDA_TAG,
  buildBaseTranslationOptions,
} from "../src/main/appSettings";
import type { AppSettings } from "../src/shared/settingsTypes";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("app settings helpers: defaults and stored values", () => {
  it("uses Codex as the hardware-safe fallback when GPU detection is unavailable", () => {
    const defaults = resolveDefaultAppSettings();

    expect(defaults.gemma.modelRepo).toBe(GEMMA_12B_MODEL_REPO);
    expect(defaults.gemma.modelFile).toBe(GEMMA_12B_MODEL_FILE_Q4_K_M);
    expect(defaults.gemma.mmprojRepo).toBe(GEMMA_12B_MMPROJ_REPO);
    expect(defaults.gemma.mmprojFile).toBe(GEMMA_12B_MMPROJ_FILE);
    expect(defaults.gemma.mmprojFile).toBe("mmproj-gemma-4-12B-it-BF16.gguf");
    expect(defaults.modelProvider).toBe("openai-codex");
    expect(defaults.gemma.vramMode).toBe("minimum12b");
    expect(defaults.codex.model).toBe(DEFAULT_CODEX_MODEL);
    expect(defaults.codex.model).toBe("gpt-5.6-sol");
    expect(defaults.codex.reasoningEffort).toBe(DEFAULT_CODEX_REASONING_EFFORT);
    expect(defaults.codex.oauthPort).toBe(DEFAULT_CODEX_OAUTH_PORT);
    expect(defaults.api.baseUrl).toBe(DEFAULT_API_BASE_URL);
    expect(defaults.api.model).toBe(DEFAULT_API_MODEL);
    expect(defaults.api.model).toBe("gpt-5.5");
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
    expect(defaults.ocr.qualityMode).toBe(DEFAULT_OCR_QUALITY_MODE);
    expect(defaults.ocr.gpuCudaTag).toBe(DEFAULT_OCR_GPU_CUDA_TAG);
    expect(defaults.inpainting?.model).toBe("flux-klein");
    expect(defaults.inpainting?.koharuBackend).toBe("auto");
    expect(defaults.inpainting?.bubbleLayoutAfterInpainting).toBe(false);
    expect(defaults.inpainting?.bubbleLayoutPaddingRatio).toBe(0.12);
    expect(defaults.blockFormatDefaults?.wordBreak).toBe("break-word");
    expect(defaults.ui?.naturalTextLayoutDefault).toBe(true);
    expect(defaults.ui?.autoFontMatchingDefault).toBe(false);
    expect(defaults.ui?.eraseOriginalWorkflowDefault).toBe(false);
    expect(defaults.ui?.bubbleLayoutWorkflowDefault).toBe(true);
    expect(defaults.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(defaults.ctx).toBe(DEFAULT_CONTEXT_TOKENS);
  });

  it("normalizes stored default line-breaking modes with the app fallback", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({ blockFormatDefaults: { wordBreak: "keep-all" } }),
        defaults,
      ).blockFormatDefaults?.wordBreak,
    ).toBe("keep-all");
    expect(
      parseStoredAppSettings(
        JSON.stringify({ blockFormatDefaults: { wordBreak: "unsupported" } }),
        defaults,
      ).blockFormatDefaults?.wordBreak,
    ).toBe("break-word");
    expect(
      parseStoredAppSettings(
        JSON.stringify({ blockFormatDefaults: {} }),
        defaults,
      ).blockFormatDefaults?.wordBreak,
    ).toBe("break-word");
  });

  it("preserves the expanded manual typography ranges and half-pixel sizes", () => {
    const defaults = resolveDefaultAppSettings();
    const parsed = parseStoredAppSettings(
      JSON.stringify({
        blockFormatDefaults: {
          fontSizePx: 511.5,
          lineHeight: 10,
          letterSpacing: -1,
          fontWidthScale: 5,
        },
      }),
      defaults,
    );

    expect(parsed.blockFormatDefaults).toMatchObject({
      fontSizePx: 511.5,
      lineHeight: 10,
      letterSpacing: -1,
      fontWidthScale: 5,
    });
  });

  it("defaults natural layout on while preserving an explicit saved off setting", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({ ui: { naturalTextLayoutDefault: true } }),
        defaults,
      ).ui?.naturalTextLayoutDefault,
    ).toBe(true);
    expect(
      parseStoredAppSettings(JSON.stringify({ ui: {} }), defaults).ui
        ?.naturalTextLayoutDefault,
    ).toBe(true);
    expect(
      parseStoredAppSettings(
        JSON.stringify({ ui: { naturalTextLayoutDefault: false } }),
        defaults,
      ).ui?.naturalTextLayoutDefault,
    ).toBe(false);
    expect(
      parseStoredAppSettings(
        JSON.stringify({ ui: { naturalTextLayoutDefault: "yes" } }),
        defaults,
      ).ui?.naturalTextLayoutDefault,
    ).toBe(true);
  });

  it("defaults automatic font matching off while preserving an explicit saved on setting", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({ ui: { autoFontMatchingDefault: true } }),
        defaults,
      ).ui?.autoFontMatchingDefault,
    ).toBe(true);
    expect(
      parseStoredAppSettings(JSON.stringify({ ui: {} }), defaults).ui
        ?.autoFontMatchingDefault,
    ).toBe(false);
    expect(
      parseStoredAppSettings(
        JSON.stringify({ ui: { autoFontMatchingDefault: false } }),
        defaults,
      ).ui?.autoFontMatchingDefault,
    ).toBe(false);
    expect(
      parseStoredAppSettings(
        JSON.stringify({ ui: { autoFontMatchingDefault: "yes" } }),
        defaults,
      ).ui?.autoFontMatchingDefault,
    ).toBe(false);
  });

  it("migrates the legacy combined workflow into erase plus nested bubble defaults", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(JSON.stringify({ ui: {} }), defaults).ui,
    ).toMatchObject({
      eraseOriginalWorkflowDefault: false,
      bubbleLayoutWorkflowDefault: true,
    });
    expect(
      parseStoredAppSettings(
        JSON.stringify({ ui: { bubbleLayoutWorkflowDefault: false } }),
        defaults,
      ).ui,
    ).toMatchObject({
      eraseOriginalWorkflowDefault: false,
      bubbleLayoutWorkflowDefault: true,
    });
    expect(
      parseStoredAppSettings(
        JSON.stringify({ ui: { bubbleLayoutWorkflowDefault: true } }),
        defaults,
      ).ui,
    ).toMatchObject({
      eraseOriginalWorkflowDefault: true,
      bubbleLayoutWorkflowDefault: true,
    });
    expect(
      parseStoredAppSettings(
        JSON.stringify({
          ui: {
            eraseOriginalWorkflowDefault: true,
            bubbleLayoutWorkflowDefault: false,
          },
        }),
        defaults,
      ).ui,
    ).toMatchObject({
      eraseOriginalWorkflowDefault: true,
      bubbleLayoutWorkflowDefault: false,
    });
  });

  it("keeps bubble layout after inpainting as an explicit safe opt-in", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          inpainting: { bubbleLayoutAfterInpainting: true },
        }),
        defaults,
      ).inpainting?.bubbleLayoutAfterInpainting,
    ).toBe(true);
    expect(
      parseStoredAppSettings(JSON.stringify({ inpainting: {} }), defaults)
        .inpainting?.bubbleLayoutAfterInpainting,
    ).toBe(false);
    expect(
      parseStoredAppSettings(
        JSON.stringify({
          inpainting: { bubbleLayoutAfterInpainting: "yes" },
        }),
        defaults,
      ).inpainting?.bubbleLayoutAfterInpainting,
    ).toBe(false);
  });

  it("defaults bubble layout padding to 12% and clamps stored ratios", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(JSON.stringify({ inpainting: {} }), defaults)
        .inpainting?.bubbleLayoutPaddingRatio,
    ).toBe(0.12);
    expect(
      parseStoredAppSettings(
        JSON.stringify({
          inpainting: { bubbleLayoutPaddingRatio: 0.24 },
        }),
        defaults,
      ).inpainting?.bubbleLayoutPaddingRatio,
    ).toBe(0.24);
    expect(
      parseStoredAppSettings(
        JSON.stringify({
          inpainting: { bubbleLayoutPaddingRatio: -0.1 },
        }),
        defaults,
      ).inpainting?.bubbleLayoutPaddingRatio,
    ).toBe(0);
    expect(
      parseStoredAppSettings(
        JSON.stringify({
          inpainting: { bubbleLayoutPaddingRatio: 1 },
        }),
        defaults,
      ).inpainting?.bubbleLayoutPaddingRatio,
    ).toBe(0.7);
    expect(
      parseStoredAppSettings(
        JSON.stringify({
          inpainting: { bubbleLayoutPaddingRatio: "invalid" },
        }),
        defaults,
      ).inpainting?.bubbleLayoutPaddingRatio,
    ).toBe(0.12);
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
    expect(rtx4090Defaults.maxTokens).toBe(DEFAULT_GEMMA_MAX_TOKENS);
    expect(rtx4090Defaults.ctx).toBe(DEFAULT_GEMMA_CONTEXT_TOKENS);
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
    expect(rtx5070Defaults.gemma.modelRepo).toBe(
      "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-i1-GGUF",
    );
    expect(rtx5070Defaults.gemma.modelFile).toBe(
      "gemma-4-26B-A4B-it-ultra-uncensored-heretic.i1-IQ3_S.gguf",
    );
    expect(rtx5070Defaults.gemma.mmprojRepo).toBe(
      "mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF",
    );
    expect(rtx5070Defaults.gemma.mmprojFile).toBe(
      "gemma-4-26B-A4B-it-ultra-uncensored-heretic.mmproj-Q8_0.gguf",
    );
    expect(rtx5070Defaults.ocr.gpuCudaTag).toBe(RTX_50_OCR_GPU_CUDA_TAG);
  });

  it("uses model-aware first-run limits for Gemini 3.5 Flash-Lite", () => {
    const defaults = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_MODEL_PROVIDER: "openai-api",
      MANGA_TRANSLATOR_API_MODEL: "gemini-3.5-flash-lite",
    });

    expect(defaults.maxTokens).toBe(65536);
    expect(defaults.ctx).toBe(524288);
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
      hardware: defaults.hardware,
      translation: defaults.translation,
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
      blockFormatDefaults: defaults.blockFormatDefaults,
      blockStylePresetGroups: defaults.blockStylePresetGroups,
      blockStylePresets: defaults.blockStylePresets,
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

  it("rejects arrays as records and normalizes stored keybindings deliberately", () => {
    const defaults: AppSettings = {
      ...resolveDefaultAppSettings(),
      keybindings: { "open-settings": "ctrl+p" },
    };

    expect(
      parseStoredAppSettings(
        JSON.stringify({ keybindings: ["ctrl+a"] }),
        defaults,
      ).keybindings,
    ).toEqual(defaults.keybindings);
    expect(
      parseStoredAppSettings(
        JSON.stringify({
          codex: [],
          keybindings: {
            "toggle-block-chrome": "CTRL+SHIFT+B",
            "delete-block": "",
            "open-settings": "shift+ctrl+k",
            "zoom-in": 42,
            "removed-action": "ctrl+r",
          },
        }),
        defaults,
      ),
    ).toMatchObject({
      codex: defaults.codex,
      keybindings: {
        "toggle-block-chrome": "ctrl+shift+b",
        "delete-block": "",
      },
    });
    expect(parseStoredAppSettings("[]", defaults).keybindings).toEqual(
      defaults.keybindings,
    );
  });

  it("removes the legacy shortcut profile and repairs bindings it had silently cleared", () => {
    const defaults = resolveDefaultAppSettings();
    const migrated = parseStoredAppSettings(
      JSON.stringify({
        shortcutProfile: "scanlation",
        keybindings: {
          "toggle-block-chrome": "",
          "toggle-text-blocks": "",
          "open-settings": "ctrl+p",
        },
      }),
      defaults,
    );

    expect(migrated).not.toHaveProperty("shortcutProfile");
    expect(migrated.keybindings).toEqual({ "open-settings": "ctrl+p" });
  });

  it("ignores legacy stored translation mode values", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings('{"translationMode":"accuracy"}', defaults),
    ).toEqual({
      modelProvider: defaults.modelProvider,
      hardware: defaults.hardware,
      translation: defaults.translation,
      gemma: defaults.gemma,
      codex: defaults.codex,
      api: defaults.api,
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      blockFormatDefaults: defaults.blockFormatDefaults,
      blockStylePresetGroups: defaults.blockStylePresetGroups,
      blockStylePresets: defaults.blockStylePresets,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });

    expect(
      parseStoredAppSettings('{"translationMode":"turbo"}', defaults),
    ).toEqual({
      modelProvider: defaults.modelProvider,
      hardware: defaults.hardware,
      translation: defaults.translation,
      gemma: defaults.gemma,
      codex: defaults.codex,
      api: defaults.api,
      ocr: defaults.ocr,
      inpainting: defaults.inpainting,
      ui: defaults.ui,
      blockFormatDefaults: defaults.blockFormatDefaults,
      blockStylePresetGroups: defaults.blockStylePresetGroups,
      blockStylePresets: defaults.blockStylePresets,
      keybindings: defaults.keybindings,
      maxTokens: defaults.maxTokens,
      ctx: defaults.ctx,
    });
  });

  it("defaults the translation language pair to Japanese -> Korean", () => {
    const defaults = resolveDefaultAppSettings();

    expect(defaults.translation).toEqual({
      sourceLanguage: "ja",
      targetLanguage: "ko",
    });
    // 기존 사용자의 저장 설정에는 translation이 없으므로 항상 ja→ko로 채운다.
    expect(parseStoredAppSettings("{}", defaults).translation).toEqual({
      sourceLanguage: "ja",
      targetLanguage: "ko",
    });
  });

  it("overrides the translation language pair from environment variables", () => {
    const defaults = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_SOURCE_LANGUAGE: "EN",
      MANGA_TRANSLATOR_TARGET_LANGUAGE: "ZH-HANS",
    } satisfies NodeJS.ProcessEnv);

    expect(defaults.translation).toEqual({
      sourceLanguage: "en",
      targetLanguage: "zh-Hans",
    });
  });

  it("normalizes invalid stored translation languages to safe values", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({
          translation: {
            sourceLanguage: "definitely not a code!",
            targetLanguage: "fr",
          },
        }),
        defaults,
      ).translation,
    ).toEqual({ sourceLanguage: "ja", targetLanguage: "fr" });
  });

  it("passes the translation language pair into base translation options", () => {
    const defaults = resolveDefaultAppSettings();
    const settings: AppSettings = {
      ...defaults,
      translation: { sourceLanguage: "en", targetLanguage: "fr" },
    };

    const options = buildBaseTranslationOptions({
      jobId: "job-lang",
      runDir: "C:/runs/job-lang",
      paths: {
        dataRoot: "C:/app-data",
        toolsDir: "C:/tools",
        llamaServerPath: "C:/tools/llama-server.exe",
      },
      settings,
      env: {} satisfies NodeJS.ProcessEnv,
    });

    expect(options.sourceLanguage).toBe("en");
    expect(options.targetLanguage).toBe("fr");
    // promptMode는 더 이상 언어 의미를 갖지 않는 중립 식별자다.
    expect(options.promptMode).toBe("overlay_bbox_lines_multiview");
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
        model: DEFAULT_API_MODEL,
      },
      ocr: {
        device: "gpu",
        qualityMode: "economy",
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
    expect(options.apiModel).toBe(DEFAULT_API_MODEL);
    expect(options.apiKey).toBeUndefined();
    expect(options.ocrDevice).toBe("gpu");
    expect(options.ocrGpuCudaTag).toBe(DEFAULT_OCR_GPU_CUDA_TAG);
    expect(options.ocrBboxMode).toBe("ocr");
    expect(options.ocrEngine).toBe("paddle_static");
    expect(options.ocrEngineDtype).toBe("float32");
    expect(options.ocrVersion).toBe("PP-OCRv6");
    expect(options.ocrTextDetectionModelName).toBe("PP-OCRv6_small_det");
    expect(options.ocrTextRecognitionModelName).toBe("PP-OCRv6_small_rec");
    expect(options.ocrMergeMode).toBe("semantic");
    expect(options.ocrDetLimit).toBe("1600");
    expect(options.ocrRecBatch).toBe("1");
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
});
