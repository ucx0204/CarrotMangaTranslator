import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import { buildSettingsFromDraft } from "../src/renderer/src/components/settingsModal/settingsModalBuildSettings";
import { resolveSettingsDraft } from "../src/renderer/src/components/settingsModal/settingsModalFormUtils";
import { createSettingsFormValues } from "../src/renderer/src/components/settingsModal/settingsModalFormValues";

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
