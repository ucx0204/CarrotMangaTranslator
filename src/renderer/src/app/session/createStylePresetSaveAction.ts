import {
  createBlockStylePreset,
  MAX_BLOCK_STYLE_PRESET_NAME_LENGTH,
  MAX_BLOCK_STYLE_PRESETS,
} from "../../../../shared/blockStylePresets";
import { appI18n } from "../../appI18n";
import { toast } from "../../lib/toastStore";
import type { PanelSessionValue } from "../../panels/panelSession";
import type { AppSessionViewModel } from "./appSessionViewModel";

type StylePresetSaveModel = {
  derivedState: Pick<AppSessionViewModel["derivedState"], "selectedBlock">;
  settingsDialog: Pick<
    AppSessionViewModel["settingsDialog"],
    "settings" | "saveSettingsQuietly"
  >;
  statusLog: Pick<AppSessionViewModel["statusLog"], "pushStatus">;
};

export function createStylePresetSaveAction({
  derivedState,
  settingsDialog,
  statusLog,
}: StylePresetSaveModel): PanelSessionValue["onCreateStylePreset"] {
  return async (input) => {
    const settings = settingsDialog.settings;
    const block = derivedState.selectedBlock;
    if (!settings || !block) {
      return false;
    }
    const existing = settings.blockStylePresets ?? [];
    if (existing.length >= MAX_BLOCK_STYLE_PRESETS) {
      toast.warn(appI18n.t("stylePresets.limitReached", { ns: "renderer" }));
      return false;
    }
    const preset = createBlockStylePreset({ block, ...input });
    const saved = await settingsDialog.saveSettingsQuietly({
      ...settings,
      blockStylePresets: [preset, ...existing],
    });
    if (!saved) {
      toast.error(appI18n.t("stylePresets.saveFailed", { ns: "renderer" }));
      return false;
    }
    const message = appI18n.t("stylePresets.saved", {
      ns: "renderer",
      name: preset.name,
    });
    statusLog.pushStatus(message);
    toast.success(message);
    return true;
  };
}

export function createStylePresetRenameAction({
  settingsDialog,
  statusLog,
}: StylePresetSaveModel): PanelSessionValue["onRenameStylePreset"] {
  return async (presetId, requestedName) => {
    const settings = settingsDialog.settings;
    const presets = settings?.blockStylePresets ?? [];
    const preset = presets.find((candidate) => candidate.id === presetId);
    const name = requestedName
      .trim()
      .slice(0, MAX_BLOCK_STYLE_PRESET_NAME_LENGTH);
    if (!settings || !preset || !name) return false;
    if (name === preset.name) return true;
    const saved = await settingsDialog.saveSettingsQuietly({
      ...settings,
      blockStylePresets: presets.map((candidate) =>
        candidate.id === presetId ? { ...candidate, name } : candidate,
      ),
    });
    if (!saved) {
      toast.error(appI18n.t("stylePresets.saveFailed", { ns: "renderer" }));
      return false;
    }
    const message = appI18n.t("stylePresets.saved", {
      ns: "renderer",
      name,
    });
    statusLog.pushStatus(message);
    toast.success(message);
    return true;
  };
}

export function createStylePresetOverwriteAction({
  derivedState,
  settingsDialog,
  statusLog,
}: StylePresetSaveModel): PanelSessionValue["onOverwriteStylePreset"] {
  return async (presetId) => {
    const settings = settingsDialog.settings;
    const block = derivedState.selectedBlock;
    const presets = settings?.blockStylePresets ?? [];
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (!settings || !block || !preset) return false;
    const updated = createBlockStylePreset({
      block,
      groupIds: preset.groupIds,
      groupId: preset.groupId,
      id: preset.id,
      name: preset.name,
      pinned: preset.pinned,
      shortcutSlot: preset.shortcutSlot,
    });
    const saved = await settingsDialog.saveSettingsQuietly({
      ...settings,
      blockStylePresets: presets.map((candidate) =>
        candidate.id === presetId ? updated : candidate,
      ),
    });
    if (!saved) {
      toast.error(appI18n.t("stylePresets.saveFailed", { ns: "renderer" }));
      return false;
    }
    const message = appI18n.t("stylePresets.saved", {
      ns: "renderer",
      name: preset.name,
    });
    statusLog.pushStatus(message);
    toast.success(message);
    return true;
  };
}
