import { describe, it, expect } from "vitest";
import {
  resolveDefaultAppSettings,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
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
  DEFAULT_GEMMA_MAX_TOKENS,
  DEFAULT_GEMMA_CONTEXT_TOKENS,
  GEMMA_26B_MODEL_REPO,
  GEMMA_26B_MODEL_FILE_IQ3_S,
  RTX_50_OCR_GPU_CUDA_TAG,
  buildBaseTranslationOptions,
} from "../src/main/appSettings";
import {
  GEMMA_12B_QAT_MMPROJ_FILE,
  GEMMA_12B_QAT_MMPROJ_REPO,
  GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_12B_QAT_MODEL_REPO,
  GEMMA_26B_QAT_MMPROJ_FILE,
  GEMMA_26B_QAT_MMPROJ_REPO,
  GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_26B_QAT_MODEL_REPO,
  GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
  GEMMA_31B_QAT_MODEL_REPO,
} from "../src/shared/modelPresets";
import type { AppSettings } from "../src/shared/settingsTypes";

const describeWindows = process.platform === "win32" ? describe : describe.skip;

describeWindows("app settings helpers: defaults and stored values", () => {
  it("uses Codex as the hardware-safe fallback when GPU detection is unavailable", () => {
    const defaults = resolveDefaultAppSettings();

    expect(defaults.gemma.modelRepo).toBe(GEMMA_12B_QAT_MODEL_REPO);
    expect(defaults.gemma.modelFile).toBe(GEMMA_12B_QAT_MODEL_FILE_Q4_K_M);
    expect(defaults.gemma.mmprojRepo).toBe(GEMMA_12B_QAT_MMPROJ_REPO);
    expect(defaults.gemma.mmprojFile).toBe(GEMMA_12B_QAT_MMPROJ_FILE);
    expect(defaults.gemma.mmprojFile).toBe(
      "mmproj-Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-BF16.gguf",
    );
    expect(defaults.gemma.fitTargetMb).toBe(512);
    expect(defaults.gemma.mmprojOffload).toBe(true);
    expect(defaults.modelProvider).toBe("openai-codex");
    expect(defaults.gemma.vramMode).toBe("minimum12b");
    expect(defaults.codex.model).toBe(DEFAULT_CODEX_MODEL);
    expect(defaults.codex.model).toBe("gpt-5.6-sol");
    expect(defaults.codex.reasoningEffort).toBe(DEFAULT_CODEX_REASONING_EFFORT);
    expect(defaults.internetResearch).toEqual({
      tavilyAnalysisProvider: "gemma",
      gemmaPreset: "qat12b",
      gemmaReasoningEffort: "high",
      gemmaMaxOutputTokens: 24576,
      gemmaContextTokens: 32768,
      apiModel: DEFAULT_API_MODEL,
      apiMaxOutputTokens: 32768,
      apiContextTokens: 65536,
      codexModel: DEFAULT_CODEX_MODEL,
      codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
      codexMaxOutputTokens: 32768,
      codexContextTokens: 262144,
      tavilyMaxCreditsPerRun: 10,
    });
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
    expect(defaults.inpainting?.model).toBe("lama-manga");
    expect(defaults.inpainting?.fluxBackend).toBe("cpu-native");
    expect(defaults.inpainting?.koharuBackend).toBe("auto");
    expect(defaults.inpainting?.bubbleLayoutAfterInpainting).toBe(false);
    expect(defaults.inpainting?.bubbleLayoutPaddingRatio).toBe(0.12);
    expect(defaults.blockFormatDefaults?.wordBreak).toBe("keep-all-overflow");
    expect(defaults.ui?.naturalTextLayoutDefault).toBe(false);
    expect(defaults.ui?.autoFontMatchingDefault).toBe(false);
    expect(defaults.ui?.aiFontSizeMatchingDefault).toBe(true);
    expect(defaults.ui?.sfxAutoFontMatchingDefault).toBe(false);
    expect(defaults.ui?.sfxInpaintAfterTranslationDefault).toBe(false);
    expect(defaults.ui?.eraseOriginalWorkflowDefault).toBe(false);
    expect(defaults.ui?.bubbleLayoutWorkflowDefault).toBe(true);
    expect(defaults.ui?.wheelZoomSensitivityPercent).toBe(1);
    expect(defaults.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(defaults.ctx).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(defaults.maxTokens).toBe(32768);
    expect(defaults.ctx).toBe(65536);
  });

  it("applies explicit compute, ROCm, and unified-memory environment defaults", () => {
    const defaults = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_COMPUTE_GPU_INDEX: "2",
      MANGA_TRANSLATOR_AMD_ROCM_TARGET: "gfx1100",
      MANGA_TRANSLATOR_MAC_ALPHA_ALLOW_UNSAFE_UNIFIED_MEMORY: "true",
    });

    expect(defaults.hardware?.computeGpuIndex).toBe(2);
    expect(defaults.gemma.llamaRocmTarget).toBe("gfx110X");
    expect(defaults.gemma.allowUnsafeUnifiedMemory).toBe(true);
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
    ).toBe("keep-all-overflow");
    expect(
      parseStoredAppSettings(
        JSON.stringify({ blockFormatDefaults: {} }),
        defaults,
      ).blockFormatDefaults?.wordBreak,
    ).toBe("keep-all-overflow");
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

  it("defaults natural layout off while preserving explicit saved settings", () => {
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
    ).toBe(false);
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
    ).toBe(false);
  });

  it("keeps legacy wheel zoom at 1% and accepts integer values through 10%", () => {
    const defaults = resolveDefaultAppSettings();
    expect(
      parseStoredAppSettings(JSON.stringify({ ui: {} }), defaults).ui
        ?.wheelZoomSensitivityPercent,
    ).toBe(1);
    expect(
      parseStoredAppSettings(
        JSON.stringify({ ui: { wheelZoomSensitivityPercent: 10 } }),
        defaults,
      ).ui?.wheelZoomSensitivityPercent,
    ).toBe(10);
    for (const invalid of [0, 11, 2.5, "8"]) {
      expect(
        parseStoredAppSettings(
          JSON.stringify({ ui: { wheelZoomSensitivityPercent: invalid } }),
          defaults,
        ).ui?.wheelZoomSensitivityPercent,
      ).toBe(1);
    }
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

  it("moves legacy auto-fit preferences to AI font-size matching", () => {
    const defaults = resolveDefaultAppSettings();

    expect(
      parseStoredAppSettings(
        JSON.stringify({ blockFormatDefaults: { autoFitText: false } }),
        defaults,
      ).ui?.aiFontSizeMatchingDefault,
    ).toBe(false);
    expect(
      parseStoredAppSettings(
        JSON.stringify({
          ui: { fontSizeAutoFitDefault: true },
          blockFormatDefaults: { autoFitText: false },
        }),
        defaults,
      ).ui?.aiFontSizeMatchingDefault,
    ).toBe(true);
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
      GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
    );
    expect(resolveDefaultAppSettings({}, 24564).modelProvider).toBe(
      "openai-codex",
    );
    expect(resolveDefaultAppSettings({}, 32768).gemma.modelFile).toBe(
      GEMMA_12B_QAT_MODEL_FILE_Q4_K_M,
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
    expect(rtx4090Defaults.gemma.vramMode).toBe("economy26b");
    expect(rtx4090Defaults.gemma.fitTargetMb).toBe(1024);
    expect(rtx4090Defaults.gemma.modelRepo).toBe(GEMMA_26B_QAT_MODEL_REPO);
    expect(rtx4090Defaults.gemma.modelFile).toBe(
      GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
    );
    expect(rtx4090Defaults.maxTokens).toBe(DEFAULT_GEMMA_MAX_TOKENS);
    expect(rtx4090Defaults.ctx).toBe(DEFAULT_GEMMA_CONTEXT_TOKENS);
    expect(rtx4090Defaults.maxTokens).toBe(24576);
    expect(rtx4090Defaults.ctx).toBe(32768);
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
    expect(rtx5070Defaults.gemma.fitTargetMb).toBe(1024);
    expect(rtx5070Defaults.gemma.modelRepo).toBe(GEMMA_26B_QAT_MODEL_REPO);
    expect(rtx5070Defaults.gemma.modelFile).toBe(
      GEMMA_26B_QAT_MODEL_FILE_Q4_K_M,
    );
    expect(rtx5070Defaults.gemma.modelRepo).toBe(
      "HauhauCS/Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-MTP",
    );
    expect(rtx5070Defaults.gemma.modelFile).toBe(
      "Gemma4-26B-A4B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf",
    );
    expect(rtx5070Defaults.gemma.mmprojRepo).toBe(GEMMA_26B_QAT_MMPROJ_REPO);
    expect(rtx5070Defaults.gemma.mmprojFile).toBe(GEMMA_26B_QAT_MMPROJ_FILE);
    expect(rtx5070Defaults.ocr.gpuCudaTag).toBe(RTX_50_OCR_GPU_CUDA_TAG);
  });

  it("uses the low-memory llama.cpp defaults only through the 8 GiB VRAM boundary", () => {
    const lowMemoryDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "NVIDIA GeForce RTX 2070 SUPER",
        memoryMb: 8192,
        rtxGeneration: 20,
        computeCapability: 7.5,
        vendor: "nvidia",
      },
    );
    const aboveBoundaryDefaults = resolveDefaultAppSettings(
      {},
      {
        name: "Test GPU above 8 GiB",
        memoryMb: 8193,
        rtxGeneration: 20,
        computeCapability: 7.5,
        vendor: "nvidia",
      },
    );

    expect(lowMemoryDefaults.gemma).toMatchObject({
      fitTargetMb: 512,
      mmprojOffload: false,
    });
    expect(aboveBoundaryDefaults.gemma).toMatchObject({
      fitTargetMb: 512,
      mmprojOffload: true,
    });
  });

  it("keeps explicit legacy choices while mode-only defaults stay in the speed family", () => {
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
    const fullModeDefaults = parseStoredAppSettings(
      JSON.stringify({ gemma: { vramMode: "full31b" } }),
      defaults,
    );
    const savedLegacy = parseStoredAppSettings(
      JSON.stringify({
        gemma: {
          modelRepo: GEMMA_26B_MODEL_REPO,
          modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
          vramMode: "economy26b",
        },
      }),
      defaults,
    );

    expect(fullModeDefaults.gemma).toMatchObject({
      modelRepo: GEMMA_31B_QAT_MODEL_REPO,
      modelFile: GEMMA_31B_QAT_MODEL_FILE_Q4_K_M,
      vramMode: "full31b",
    });
    expect(savedLegacy.gemma).toMatchObject({
      modelRepo: GEMMA_26B_MODEL_REPO,
      modelFile: GEMMA_26B_MODEL_FILE_IQ3_S,
      vramMode: "economy26b",
    });
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
        fitTargetMb: defaults.gemma.fitTargetMb,
        mmprojOffload: defaults.gemma.mmprojOffload,
        llamaRuntimeProfile: defaults.gemma.llamaRuntimeProfile,
      },
      codex: defaults.codex,
      internetResearch: defaults.internetResearch,
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
      internetResearch: defaults.internetResearch,
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
      internetResearch: defaults.internetResearch,
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
      },
      internetResearch: {
        tavilyAnalysisProvider: "gemma",
        gemmaPreset: "qat12b",
        gemmaReasoningEffort: "high",
        gemmaMaxOutputTokens: 32768,
        gemmaContextTokens: 65536,
        apiModel: DEFAULT_API_MODEL,
        apiMaxOutputTokens: 32768,
        apiContextTokens: 65536,
        codexModel: DEFAULT_CODEX_MODEL,
        codexReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
        codexMaxOutputTokens: 32768,
        codexContextTokens: 65536,
        tavilyMaxCreditsPerRun: 10,
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
    expect(options.fitTargetMb).toBe(1024);
    expect(options.workingDir).toBe("C:/app-data");
    expect(options.outputDir).toBe("C:/runs/job-1");
    expect(options.label).toBe("app-job-1");
  });
});
