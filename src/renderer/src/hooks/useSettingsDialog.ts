import React from "react";
import type { AppSettings } from "../../../shared/types";

type UseSettingsDialogResult = {
  settings: AppSettings | null;
  settingsOpen: boolean;
  settingsBusy: boolean;
  openSettings: () => Promise<void>;
  closeSettings: () => void;
  submitSettings: (nextSettings: AppSettings) => Promise<void>;
  resetSettings: () => Promise<void>;
};

export function useSettingsDialog(pushStatus: (line: string) => void): UseSettingsDialogResult {
  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsBusy, setSettingsBusy] = React.useState(false);

  const refreshSettings = React.useCallback(async () => {
    const next = await window.mangaApi.getSettings();
    setSettings(next);
    return next;
  }, []);

  React.useEffect(() => {
    void refreshSettings().catch((error) => {
      console.error(error);
    });
  }, [refreshSettings]);

  const openSettings = React.useCallback(async () => {
    if (settings) {
      setSettingsOpen(true);
      return;
    }

    setSettingsBusy(true);
    try {
      await refreshSettings();
      setSettingsOpen(true);
    } catch (error) {
      console.error(error);
      pushStatus("설정을 불러오지 못했습니다.");
    } finally {
      setSettingsBusy(false);
    }
  }, [pushStatus, refreshSettings, settings]);

  const closeSettings = React.useCallback(() => {
    setSettingsOpen((open) => (settingsBusy ? open : false));
  }, [settingsBusy]);

  const submitSettings = React.useCallback(
    async (nextSettings: AppSettings) => {
      setSettingsBusy(true);
      try {
        const saved = await window.mangaApi.saveSettings(nextSettings);
        setSettings(saved);
        setSettingsOpen(false);
        pushStatus("설정을 저장했습니다. 다음 번 번역 실행부터 적용됩니다.");
      } catch (error) {
        console.error(error);
        pushStatus("설정을 저장하지 못했습니다.");
      } finally {
        setSettingsBusy(false);
      }
    },
    [pushStatus]
  );

  const resetSettings = React.useCallback(async () => {
    setSettingsBusy(true);
    try {
      const reset = await window.mangaApi.resetSettings();
      setSettings(reset);
      pushStatus("설정을 기본값으로 복원했습니다. 다음 번 번역 실행부터 적용됩니다.");
    } catch (error) {
      console.error(error);
      pushStatus("기본 설정을 복원하지 못했습니다.");
    } finally {
      setSettingsBusy(false);
    }
  }, [pushStatus]);

  return { settings, settingsOpen, settingsBusy, openSettings, closeSettings, submitSettings, resetSettings };
}
