import { appI18n } from "../../appI18n";
import { toast } from "../../lib/toastStore";
import type { PanelSessionValue } from "../../panels/panelSession";
import type { AppSessionViewModel } from "./appSessionViewModel";

type StylePresetDeleteModel = {
  settingsDialog: Pick<
    AppSessionViewModel["settingsDialog"],
    "settings" | "saveSettingsQuietly"
  >;
  statusLog: Pick<AppSessionViewModel["statusLog"], "pushStatus">;
};

export function createStylePresetDeleteAction({
  settingsDialog,
  statusLog,
}: StylePresetDeleteModel): PanelSessionValue["onDeleteStylePreset"] {
  return async (presetId) => {
    const settings = settingsDialog.settings;
    const presets = settings?.blockStylePresets ?? [];
    const preset = presets.find((candidate) => candidate.id === presetId);
    if (!settings || !preset) return false;

    const saved = await settingsDialog.saveSettingsQuietly({
      ...settings,
      blockStylePresets: presets.filter(
        (candidate) => candidate.id !== presetId,
      ),
    });
    if (!saved) {
      toast.error(appI18n.t("stylePresets.deleteFailed", { ns: "renderer" }));
      return false;
    }

    const message = appI18n.t("stylePresets.deleted", {
      ns: "renderer",
      name: preset.name,
    });
    statusLog.pushStatus(message);
    toast.success(message);
    return true;
  };
}
