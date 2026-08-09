import {
  createBlockStylePreset,
  MAX_BLOCK_STYLE_PRESETS,
} from "../../../../shared/blockStylePresets";
import { appI18n } from "../../appI18n";
import { toast } from "../../lib/toastStore";
import type { PanelSessionValue } from "../../panels/panelSession";
import type { AppSessionViewModel } from "./appSessionViewModel";

export function createStylePresetSaveAction({
  derivedState,
  settingsDialog,
  statusLog,
}: AppSessionViewModel): PanelSessionValue["onCreateStylePreset"] {
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
      blockStylePresets: [...existing, preset],
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
