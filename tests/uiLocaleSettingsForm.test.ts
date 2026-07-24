import { describe, expect, it } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/appSettings";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import { buildSettingsFromDraft } from "../src/renderer/src/components/settingsModal/settingsModalBuildSettings";
import { resolveSettingsDraft } from "../src/renderer/src/components/settingsModal/settingsModalFormUtils";
import { createSettingsFormValues } from "../src/renderer/src/components/settingsModal/settingsModalFormValues";

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
