import { describe, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/settings/appSettingsDefaults";
import { createStylePresetDeleteAction } from "../src/renderer/src/app/session/createStylePresetDeleteAction";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import { createBlockStylePresetFromDefaults } from "../src/shared/blockStylePresets";

describe("style preset session actions", () => {
  it("persists removal and reports success", async () => {
    const settings = resolveDefaultAppSettings({});
    const preset = createBlockStylePresetFromDefaults({
      defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
      id: "style-preset:delete-me",
      name: "삭제할 프리셋",
    });
    settings.blockStylePresets = [preset];
    const saveSettingsQuietly = vi.fn(async (next) => next);
    const pushStatus = vi.fn();
    const action = createStylePresetDeleteAction({
      settingsDialog: {
        settings,
        saveSettingsQuietly,
      },
      statusLog: { pushStatus },
    });

    await expect(action(preset.id)).resolves.toBe(true);
    expect(saveSettingsQuietly).toHaveBeenCalledWith({
      ...settings,
      blockStylePresets: [],
    });
    expect(pushStatus).toHaveBeenCalledOnce();
  });

  it("keeps the preset when persistence fails", async () => {
    const settings = resolveDefaultAppSettings({});
    const preset = createBlockStylePresetFromDefaults({
      defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
      id: "style-preset:keep-me",
      name: "남길 프리셋",
    });
    settings.blockStylePresets = [preset];
    const saveSettingsQuietly = vi.fn(async () => null);
    const pushStatus = vi.fn();
    const action = createStylePresetDeleteAction({
      settingsDialog: {
        settings,
        saveSettingsQuietly,
      },
      statusLog: { pushStatus },
    });

    await expect(action(preset.id)).resolves.toBe(false);
    expect(pushStatus).not.toHaveBeenCalled();
  });
});
