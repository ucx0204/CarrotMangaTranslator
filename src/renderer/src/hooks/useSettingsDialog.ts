import React from "react";
import type { AppSettings } from "../../../shared/settingsTypes";
import { mangaGateway } from "../api/mangaGateway";

type UseSettingsDialogResult = {
  settings: AppSettings | null;
  settingsOpen: boolean;
  settingsBusy: boolean;
  openSettings: () => Promise<void>;
  closeSettings: () => void;
  submitSettings: (nextSettings: AppSettings) => Promise<void>;
  resetSettings: () => Promise<void>;
  saveSettingsQuietly: (
    nextSettings: AppSettings,
  ) => Promise<AppSettings | null>;
};

export function useSettingsDialog(
  pushStatus: (line: string) => void,
): UseSettingsDialogResult {
  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsBusy, setSettingsBusy] = React.useState(false);
  const refreshSettings = useSettingsRefresh(setSettings);
  const openSettings = useOpenSettingsAction({
    pushStatus,
    refreshSettings,
    setSettingsBusy,
    setSettingsOpen,
    settings,
  });
  const closeSettings = useCloseSettingsAction(settingsBusy, setSettingsOpen);
  const submitSettings = useSubmitSettingsAction({
    pushStatus,
    setSettings,
    setSettingsBusy,
    setSettingsOpen,
  });
  const saveSettingsQuietly = useQuietSettingsSaveAction(setSettings);
  const resetSettings = useResetSettingsAction({
    pushStatus,
    setSettings,
    setSettingsBusy,
  });

  React.useEffect(() => {
    void refreshSettings().catch((error) => {
      console.error(error);
    });
  }, [refreshSettings]);

  return {
    settings,
    settingsOpen,
    settingsBusy,
    openSettings,
    closeSettings,
    submitSettings,
    resetSettings,
    saveSettingsQuietly,
  };
}

function useSettingsRefresh(
  setSettings: React.Dispatch<React.SetStateAction<AppSettings | null>>,
): () => Promise<AppSettings> {
  return React.useCallback(async () => {
    const next = await mangaGateway.getSettings();
    setSettings(next);
    return next;
  }, [setSettings]);
}

type OpenSettingsActionOptions = {
  pushStatus: (line: string) => void;
  refreshSettings: () => Promise<AppSettings>;
  setSettingsBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  settings: AppSettings | null;
};

function useOpenSettingsAction({
  pushStatus,
  refreshSettings,
  setSettingsBusy,
  setSettingsOpen,
  settings,
}: OpenSettingsActionOptions): () => Promise<void> {
  return React.useCallback(async () => {
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
  }, [pushStatus, refreshSettings, setSettingsBusy, setSettingsOpen, settings]);
}

function useCloseSettingsAction(
  settingsBusy: boolean,
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>,
): () => void {
  return React.useCallback(() => {
    setSettingsOpen((open) => (settingsBusy ? open : false));
  }, [settingsBusy, setSettingsOpen]);
}

type SettingsMutationOptions = {
  pushStatus: (line: string) => void;
  setSettings: React.Dispatch<React.SetStateAction<AppSettings | null>>;
  setSettingsBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsOpen?: React.Dispatch<React.SetStateAction<boolean>>;
};

function useSubmitSettingsAction({
  pushStatus,
  setSettings,
  setSettingsBusy,
  setSettingsOpen,
}: Required<SettingsMutationOptions>): (
  nextSettings: AppSettings,
) => Promise<void> {
  return React.useCallback(
    async (nextSettings) => {
      setSettingsBusy(true);
      try {
        const saved = await mangaGateway.saveSettings(nextSettings);
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
    [pushStatus, setSettings, setSettingsBusy, setSettingsOpen],
  );
}

function useQuietSettingsSaveAction(
  setSettings: React.Dispatch<React.SetStateAction<AppSettings | null>>,
): (nextSettings: AppSettings) => Promise<AppSettings | null> {
  return React.useCallback(
    async (nextSettings) => {
      try {
        const saved = await mangaGateway.saveSettings(nextSettings);
        setSettings(saved);
        return saved;
      } catch (error) {
        console.error(error);
        return null;
      }
    },
    [setSettings],
  );
}

function useResetSettingsAction({
  pushStatus,
  setSettings,
  setSettingsBusy,
}: SettingsMutationOptions): () => Promise<void> {
  return React.useCallback(async () => {
    setSettingsBusy(true);
    try {
      const reset = await mangaGateway.resetSettings();
      setSettings(reset);
      pushStatus(
        "설정을 기본값으로 복원했습니다. 다음 번 번역 실행부터 적용됩니다.",
      );
    } catch (error) {
      console.error(error);
      pushStatus("기본 설정을 복원하지 못했습니다.");
    } finally {
      setSettingsBusy(false);
    }
  }, [pushStatus, setSettings, setSettingsBusy]);
}
