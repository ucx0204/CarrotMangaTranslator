import { describe, expect, it, vi } from "vitest";
import { resolveDefaultAppSettings } from "../src/main/settings/appSettingsDefaults";
import { createStylePresetDeleteAction } from "../src/renderer/src/app/session/createStylePresetDeleteAction";
import {
  createStylePresetRenameAction,
  createStylePresetSaveAction,
} from "../src/renderer/src/app/session/createStylePresetSaveAction";
import { DEFAULT_BLOCK_FORMAT_DEFAULTS } from "../src/shared/blockFormat";
import {
  createBlockStylePresetFromDefaults,
  type BlockStylePreset,
} from "../src/shared/blockStylePresets";
import { setupRendererI18n } from "./setupI18n";
import type { TranslationBlock } from "../src/shared/textTypes";

setupRendererI18n();

describe("style preset session actions", () => {
  it("prepends a newly captured preset", async () => {
    const settings = resolveDefaultAppSettings({});
    const existing = createBlockStylePresetFromDefaults({
      defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
      id: "style-preset:existing",
      name: "기존 프리셋",
    });
    settings.blockStylePresets = [existing];
    const saveSettingsQuietly = vi.fn(async (next) => next);
    const action = createStylePresetSaveAction({
      derivedState: { selectedBlock: makeBlock() },
      settingsDialog: { settings, saveSettingsQuietly },
      statusLog: { pushStatus: vi.fn() },
    });

    await expect(
      action({ name: "새 프리셋", pinned: true, groupIds: ["font"] }),
    ).resolves.toBe(true);
    const saved = saveSettingsQuietly.mock.calls[0]?.[0];
    expect(
      saved?.blockStylePresets?.map((preset: BlockStylePreset) => preset.name),
    ).toEqual(["새 프리셋", "기존 프리셋"]);
  });

  it("renames a preset without changing its order or format", async () => {
    const settings = resolveDefaultAppSettings({});
    const preset = createBlockStylePresetFromDefaults({
      defaults: DEFAULT_BLOCK_FORMAT_DEFAULTS,
      id: "style-preset:rename-me",
      name: "변경 전",
    });
    settings.blockStylePresets = [preset];
    const saveSettingsQuietly = vi.fn(async (next) => next);
    const action = createStylePresetRenameAction({
      derivedState: { selectedBlock: null },
      settingsDialog: { settings, saveSettingsQuietly },
      statusLog: { pushStatus: vi.fn() },
    });

    await expect(action(preset.id, "  변경 후  ")).resolves.toBe(true);
    const savedPreset =
      saveSettingsQuietly.mock.calls[0]?.[0].blockStylePresets?.[0];
    expect(savedPreset).toEqual({ ...preset, name: "변경 후" });
  });

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

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 10, y: 20, w: 200, h: 120 },
    sourceText: "원문",
    translatedText: "번역",
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
