import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import { buildSettingsFromDraft } from "../src/renderer/src/components/settingsModal/settingsModalBuildSettings";
import { resolveSettingsDraft } from "../src/renderer/src/components/settingsModal/settingsModalFormUtils";
import { createSettingsFormValues } from "../src/renderer/src/components/settingsModal/settingsModalFormValues";

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
