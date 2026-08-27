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

describe("remote model settings form", () => {
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

  it("repairs an unsupported saved Codex reasoning level", () => {
    expect(resolveCodexReasoningEffortForModel("gpt-5.6-luna", "ultra")).toBe(
      "medium",
    );
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
    };
    const values = {
      ...createSettingsFormValues(initialSettings),
      uiLocale: "en" as const,
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
    });
  });
});

describe("Vertex service-account settings form", () => {
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
