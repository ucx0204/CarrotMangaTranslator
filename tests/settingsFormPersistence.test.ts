import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import { buildSettingsFromDraft } from "../src/renderer/src/components/settingsModal/settingsModalBuildSettings";
import {
  isSettingsFormSubmittable,
  resolveSettingsDraft,
} from "../src/renderer/src/components/settingsModal/settingsModalFormUtils";
import { createSettingsFormValues } from "../src/renderer/src/components/settingsModal/settingsModalFormValues";
import { resolveCodexReasoningEffortForModel } from "../src/renderer/src/components/settingsOptions";
import { normalizeVertexAuthSettings } from "../src/main/settings/vertexAuthSettingsNormalize";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../src/shared/settingsSecrets";
import { createDefaultApiProfileFormValues } from "../src/renderer/src/components/settingsModal/settingsModalProfileFormValues";

describe("remote model settings form", () => {
  it("keeps the masked API key count for display without saving the metadata", () => {
    const initialSettings = resolveDefaultAppSettings();
    initialSettings.api.apiKey = SETTINGS_SECRET_PRESERVE_SENTINEL;
    initialSettings.api.apiKeyCount = 3;
    const values = createSettingsFormValues(initialSettings);

    expect(values.apiKeyCount).toBe(3);

    const result = buildSettingsFromDraft({
      draft: resolveSettingsDraft(values),
      initialSettings,
      keybindings: initialSettings.keybindings ?? {},
      blockFormatDefaults:
        initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
      values,
    });
    expect(result.api.apiKey).toBe(SETTINGS_SECRET_PRESERVE_SENTINEL);
    expect(result.api.apiKeyCount).toBeUndefined();
  });

  it("accepts a complete OpenAI-compatible API setup", () => {
    const values = {
      ...createSettingsFormValues(resolveDefaultAppSettings()),
      modelProvider: "openai-api" as const,
      apiBaseUrl: "https://api.openai.com/v1",
      apiModel: "gpt-5.5",
    };
    const draft = resolveSettingsDraft(values);

    expect(isSettingsFormSubmittable(values, draft)).toBe(true);
  });

  it("keeps valid stored provider profiles when incomplete drafts are ignored", () => {
    const initialSettings = resolveDefaultAppSettings();
    const initialNimProfile = {
      baseUrl: "https://integrate.api.nvidia.com/v1",
      model: "stored-vision-model",
      apiKey: "stored-key",
      keyMaxAttempts: 2,
      retryDelaySeconds: 1,
      temperature: null,
      topP: null,
      topK: null,
      reasoningEffort: null,
      extraBodyJson: "",
      customHeadersJson: "",
    };
    initialSettings.api.profiles = {
      ...initialSettings.api.profiles,
      "nvidia-nim": initialNimProfile,
    };
    const generationLimits = initialSettings.generationLimits;
    if (!generationLimits) {
      throw new Error("Default generation limits are missing");
    }
    initialSettings.generationLimits = {
      ...generationLimits,
      api: {
        ...initialSettings.generationLimits?.api,
        "nvidia-nim": { maxTokens: 12000, contextTokens: 24000 },
      },
    };
    const baseValues = createSettingsFormValues(initialSettings);
    const nimValues = createDefaultApiProfileFormValues("nvidia-nim");
    const openRouterValues = createDefaultApiProfileFormValues("openrouter");
    const values = {
      ...baseValues,
      modelProvider: "openai-api" as const,
      apiProfiles: {
        ...baseValues.apiProfiles,
        "nvidia-nim": {
          ...nimValues,
          apiModel: "   ",
        },
        openrouter: {
          ...openRouterValues,
          apiBaseUrl: "not a URL",
          apiModel: "",
        },
      },
      generationLimitProfiles: {
        ...baseValues.generationLimitProfiles,
        api: {
          ...baseValues.generationLimitProfiles.api,
          "nvidia-nim": {
            maxTokens: "not-a-number",
            contextTokens: "not-a-number",
          },
        },
      },
    };

    const result = buildSettingsFromDraft({
      draft: resolveSettingsDraft(values),
      initialSettings,
      keybindings: initialSettings.keybindings ?? {},
      blockFormatDefaults:
        initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
      values,
    });

    expect(result.api.profiles?.["nvidia-nim"]).toEqual(initialNimProfile);
    expect(result.api.profiles?.openrouter).toBeUndefined();
    expect(result.generationLimits?.api["nvidia-nim"]).toEqual({
      maxTokens: 12000,
      contextTokens: 24000,
    });
    expect(result.generationLimits?.api[values.apiProvider]).toEqual({
      maxTokens: Number(values.maxTokens),
      contextTokens: Number(values.contextTokens),
    });
  });

  it("repairs an unsupported saved Codex reasoning level", () => {
    expect(resolveCodexReasoningEffortForModel("gpt-5.6-luna", "ultra")).toBe(
      "medium",
    );
  });
});

describe("internet research settings form", () => {
  it("round-trips independent Gemma, Codex, and Tavily settings", () => {
    const initialSettings = resolveDefaultAppSettings();
    const values = {
      ...createSettingsFormValues(initialSettings),
      researchTavilyAnalysisProvider: "api" as const,
      researchGemmaPreset: "qat12b" as const,
      researchGemmaReasoningEffort: "high" as const,
      researchGemmaMaxOutputTokens: "24576",
      researchGemmaContextTokens: "98304",
      researchApiModel: "research-api-model",
      researchApiMaxOutputTokens: "28672",
      researchApiContextTokens: "73728",
      researchCodexModel: "gpt-5.5",
      researchCodexReasoningEffort: "high" as const,
      researchCodexMaxOutputTokens: "30720",
      researchCodexContextTokens: "81920",
      tavilyApiKey: "tvly-private",
      tavilyMaxCreditsPerRun: "7",
    };
    const draft = resolveSettingsDraft(values);
    const result = buildSettingsFromDraft({
      draft,
      initialSettings,
      keybindings: initialSettings.keybindings ?? {},
      blockFormatDefaults:
        initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
      values,
    });

    expect(isSettingsFormSubmittable(values, draft)).toBe(true);
    expect(result.internetResearch).toEqual({
      tavilyAnalysisProvider: "api",
      gemmaPreset: "qat12b",
      gemmaReasoningEffort: "high",
      gemmaMaxOutputTokens: 24576,
      gemmaContextTokens: 98304,
      apiModel: "research-api-model",
      apiMaxOutputTokens: 28672,
      apiContextTokens: 73728,
      apiProfiles: {
        custom: {
          model: "research-api-model",
          maxOutputTokens: 28672,
          contextTokens: 73728,
        },
      },
      codexModel: "gpt-5.5",
      codexReasoningEffort: "high",
      codexMaxOutputTokens: 30720,
      codexContextTokens: 81920,
      tavilyApiKey: "tvly-private",
      tavilyMaxCreditsPerRun: 7,
    });
    expect(result.codex).toEqual(initialSettings.codex);
    expect(result.maxTokens).toBe(initialSettings.maxTokens);
    expect(result.ctx).toBe(initialSettings.ctx);
  });

  it("accepts a user-defined Tavily budget above the former limit", () => {
    const values = {
      ...createSettingsFormValues(resolveDefaultAppSettings()),
      tavilyMaxCreditsPerRun: "11",
    };
    const draft = resolveSettingsDraft(values);

    expect(draft.tavilyMaxCreditsPerRunValid).toBe(true);
    expect(isSettingsFormSubmittable(values, draft)).toBe(true);
  });

  it("rejects Tavily budgets below five, fractional, or unsafe", () => {
    for (const tavilyMaxCreditsPerRun of ["4", "5.5", "9007199254740992"]) {
      const values = {
        ...createSettingsFormValues(resolveDefaultAppSettings()),
        tavilyMaxCreditsPerRun,
      };
      const draft = resolveSettingsDraft(values);
      expect(draft.tavilyMaxCreditsPerRunValid).toBe(false);
      expect(isSettingsFormSubmittable(values, draft)).toBe(false);
    }
  });

  it("requires a Codex research model independently of the Tavily analyzer", () => {
    const values = {
      ...createSettingsFormValues(resolveDefaultAppSettings()),
      researchCodexModel: "   ",
    };
    const draft = resolveSettingsDraft(values);
    expect(isSettingsFormSubmittable(values, draft)).toBe(false);
  });
});

describe("UI locale settings form", () => {
  it("loads the normalized locale into the form", () => {
    const settings = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_UI_LOCALE: "zh-TW",
    });
    expect(createSettingsFormValues(settings).uiLocale).toBe("zh-Hant");
  });

  it("saves the selected locale without dropping other UI preferences", () => {
    const initialSettings = resolveDefaultAppSettings({
      MANGA_TRANSLATOR_UI_LOCALE: "ko-KR",
    });
    initialSettings.ui = {
      ...initialSettings.ui,
      inpaintingGuideHidden: true,
      blockModeDefault: "keep",
      wheelZoomSensitivityPercent: 3,
    };
    const values = {
      ...createSettingsFormValues(initialSettings),
      uiLocale: "en" as const,
      wheelZoomSensitivityPercent: 10,
    };
    const result = buildSettingsFromDraft({
      draft: resolveSettingsDraft(values),
      initialSettings,
      keybindings: initialSettings.keybindings ?? {},
      blockFormatDefaults:
        initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
      values,
    });
    expect(result.ui).toMatchObject({
      locale: "en",
      inpaintingGuideHidden: true,
      blockModeDefault: "keep",
      wheelZoomSensitivityPercent: 10,
    });
  });
});

describe("Vertex service-account settings form", () => {
  it("normalizes absent, token, and service-account settings", () => {
    expect(normalizeVertexAuthSettings(null)).toEqual({});
    expect(
      normalizeVertexAuthSettings({
        vertexAuthMode: "unexpected",
        vertexServiceAccountPath: "   ",
      }),
    ).toEqual({ vertexAuthMode: "access-token" });
    expect(
      normalizeVertexAuthSettings({
        vertexAuthMode: "service-account",
        vertexServiceAccountPath: " C:\\keys\\vertex.json ",
      }),
    ).toEqual({
      vertexAuthMode: "service-account",
      vertexServiceAccountPath: "C:\\keys\\vertex.json",
    });
  });

  it("defaults new Vertex setups to service-account JSON", () => {
    const settings = resolveDefaultAppSettings({});
    settings.api.vertexAuthMode = undefined;
    settings.api.vertexServiceAccountPath = undefined;
    settings.api.apiKey = "";

    expect(createSettingsFormValues(settings).apiVertexAuthMode).toBe(
      "service-account",
    );
  });

  it("keeps legacy Vertex access-token setups working", () => {
    const settings = resolveDefaultAppSettings({});
    settings.api = {
      ...settings.api,
      baseUrl:
        "https://aiplatform.googleapis.com/v1/projects/sample-project/locations/global/endpoints/openapi",
      apiKey: "legacy-access-token",
      provider: undefined,
      profiles: undefined,
      vertexAuthMode: undefined,
    };

    expect(createSettingsFormValues(settings).apiVertexAuthMode).toBe(
      "access-token",
    );
  });

  it("round-trips the authentication mode and local JSON path", () => {
    const initialSettings = resolveDefaultAppSettings({});
    const values = {
      ...createSettingsFormValues(initialSettings),
      apiBaseUrl:
        "https://aiplatform.googleapis.com/v1/projects/sample-project/locations/global/endpoints/openapi",
      apiVertexAuthMode: "service-account" as const,
      apiVertexServiceAccountPath: "C:\\keys\\vertex.json",
    };
    const result = buildSettingsFromDraft({
      draft: resolveSettingsDraft(values),
      initialSettings,
      keybindings: initialSettings.keybindings ?? {},
      blockFormatDefaults:
        initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
      values,
    });

    expect(result.api).toMatchObject({
      vertexAuthMode: "service-account",
      vertexServiceAccountPath: "C:\\keys\\vertex.json",
    });
    expect(createSettingsFormValues(result)).toMatchObject({
      apiVertexAuthMode: "service-account",
      apiVertexServiceAccountPath: "C:\\keys\\vertex.json",
    });
  });
});

describe("GPU selection settings form", () => {
  it("represents missing stored preferences as automatic selections", () => {
    const initialSettings = resolveDefaultAppSettings({});
    initialSettings.hardware = undefined;

    expect(createSettingsFormValues(initialSettings)).toMatchObject({
      graphicsGpuPreference: "auto",
      computeGpuIndex: null,
    });
  });

  it("loads GPU 0 and saves an explicit graphics and compute selection", () => {
    const initialSettings = resolveDefaultAppSettings({});
    initialSettings.hardware = {
      graphicsGpuPreference: "auto",
      computeGpuIndex: 0,
    };
    const initialValues = createSettingsFormValues(initialSettings);

    expect(initialValues.computeGpuIndex).toBe(0);

    const values = {
      ...initialValues,
      graphicsGpuPreference: "high-performance" as const,
      computeGpuIndex: 1,
    };
    const result = buildSettingsFromDraft({
      draft: resolveSettingsDraft(values),
      initialSettings,
      keybindings: initialSettings.keybindings ?? {},
      blockFormatDefaults:
        initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
      values,
    });

    expect(result.hardware).toEqual({
      graphicsGpuPreference: "high-performance",
      computeGpuIndex: 1,
    });
  });

  it("saves automatic compute selection by omitting the stored index", () => {
    const initialSettings = resolveDefaultAppSettings({});
    initialSettings.hardware = {
      graphicsGpuPreference: "high-performance",
      computeGpuIndex: 1,
    };
    const values = {
      ...createSettingsFormValues(initialSettings),
      graphicsGpuPreference: "auto" as const,
      computeGpuIndex: null,
    };
    const result = buildSettingsFromDraft({
      draft: resolveSettingsDraft(values),
      initialSettings,
      keybindings: initialSettings.keybindings ?? {},
      blockFormatDefaults:
        initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
      values,
    });

    expect(result.hardware).toEqual({
      graphicsGpuPreference: "auto",
    });
  });
});

describe("Gemma VRAM tuning settings form", () => {
  it("round-trips the reserve target and CPU mmproj choice", () => {
    const initialSettings = resolveDefaultAppSettings();
    const values = {
      ...createSettingsFormValues(initialSettings),
      gemmaFitTargetMb: 512,
      gemmaMmprojOffload: false,
    };
    const result = buildSettingsFromDraft({
      draft: resolveSettingsDraft(values),
      initialSettings,
      keybindings: initialSettings.keybindings ?? {},
      blockFormatDefaults:
        initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
      values,
    });

    expect(result.gemma).toMatchObject({
      fitTargetMb: 512,
      mmprojOffload: false,
    });
    expect(createSettingsFormValues(result)).toMatchObject({
      gemmaFitTargetMb: 512,
      gemmaMmprojOffload: false,
    });
  });

  it("uses safe form fallbacks for optional legacy engine fields", () => {
    const settings = resolveDefaultAppSettings();
    settings.gemma.llamaRuntimeProfile = undefined;
    settings.ocr.pipeline = undefined;
    settings.ocr.gpuBackend = undefined;
    delete (settings.ocr as Partial<typeof settings.ocr>).qualityMode;
    settings.inpainting = undefined;

    expect(createSettingsFormValues(settings)).toMatchObject({
      llamaRuntimeProfile: "cuda12",
      ocrPipeline: "paddle-legacy",
      ocrGpuBackend: "cuda",
      ocrQualityMode: "economy",
      inpaintingModel: "flux-klein",
      fluxBackend: "cuda-native",
    });
  });
});

describe("bubble layout padding settings form", () => {
  it("starts at the recommended 12% when no saved ratio exists", () => {
    const settings = resolveDefaultAppSettings();
    settings.inpainting = {
      ...settings.inpainting,
      bubbleLayoutPaddingRatio: undefined,
    };

    expect(createSettingsFormValues(settings).bubbleLayoutPaddingRatio).toBe(
      0.12,
    );
  });

  it("loads the normalized ratio and saves it without dropping inpainting settings", () => {
    const initialSettings = resolveDefaultAppSettings();
    initialSettings.inpainting = {
      ...initialSettings.inpainting,
      bubbleLayoutAfterInpainting: true,
      bubbleLayoutPaddingRatio: 0.23,
    };
    const values = createSettingsFormValues(initialSettings);

    expect(values.bubbleLayoutPaddingRatio).toBe(0.23);

    const result = buildSettingsFromDraft({
      draft: resolveSettingsDraft(values),
      initialSettings,
      keybindings: initialSettings.keybindings ?? {},
      blockFormatDefaults:
        initialSettings.blockFormatDefaults ?? DEFAULT_BLOCK_FORMAT_DEFAULTS,
      values: { ...values, bubbleLayoutPaddingRatio: 0.41 },
    });

    expect(result.inpainting).toMatchObject({
      bubbleLayoutAfterInpainting: true,
      bubbleLayoutPaddingRatio: 0.41,
    });
  });
});
