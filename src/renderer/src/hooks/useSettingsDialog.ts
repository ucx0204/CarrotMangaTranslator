import React from "react";
import { useTranslation } from "react-i18next";
import { normalizeUiLocale } from "../../../shared/uiLocales";
import { appI18n } from "../appI18n";
import type { AppSettings } from "../../../shared/settingsTypes";
import { settingsGateway as mangaGateway } from "../api/settingsGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import { toast } from "../lib/toastStore";

type UseSettingsDialogResult = {
  settings: AppSettings | null;
  settingsOpen: boolean;
  settingsBusy: boolean;
  openRequest: SettingsOpenRequest;
  openSettings: (target?: SettingsOpenTarget) => Promise<void>;
  closeSettings: () => void;
  submitSettings: (nextSettings: AppSettings) => Promise<void>;
  resetSettings: () => Promise<AppSettings | null>;
  saveSettingsQuietly: (
    nextSettings: AppSettings,
  ) => Promise<AppSettings | null>;
};

type SettingsOpenTarget = "general" | "style-presets";
export type SettingsOpenRequest = {
  revision: number;
  target: SettingsOpenTarget;
};

export function useSettingsDialog(
  pushStatus: (line: string) => void,
): UseSettingsDialogResult {
  const [settings, setSettings] = React.useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsBusy, setSettingsBusy] = React.useState(false);
  const [openRequest, setOpenRequest] = React.useState<SettingsOpenRequest>({
    revision: 0,
    target: "general",
  });
  const refreshSettings = useSettingsRefresh(setSettings);
  const openSettings = useOpenSettingsAction({
    pushStatus,
    refreshSettings,
    setSettingsBusy,
    setSettingsOpen,
    setOpenRequest,
    settings,
  });
  const closeSettings = useCloseSettingsAction(settingsBusy, setSettingsOpen);
  const submitSettings = useSubmitSettingsAction({
    pushStatus,
    setSettings,
    setSettingsBusy,
  });
  const saveSettingsQuietly = useQuietSettingsSaveAction(setSettings);
  const resetSettings = useResetSettingsAction({
    pushStatus,
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
    openRequest,
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
  setOpenRequest: React.Dispatch<React.SetStateAction<SettingsOpenRequest>>;
  settings: AppSettings | null;
};

function useOpenSettingsAction({
  pushStatus,
  refreshSettings,
  setSettingsBusy,
  setSettingsOpen,
  setOpenRequest,
  settings,
}: OpenSettingsActionOptions): (target?: SettingsOpenTarget) => Promise<void> {
  const { t } = useTranslation("renderer");
  return React.useCallback(
    async (target = "general") => {
      setOpenRequest((current) => ({
        revision: current.revision + 1,
        target,
      }));
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
        pushStatus(t("settings.loadFailed"));
      } finally {
        setSettingsBusy(false);
      }
    },
    [
      pushStatus,
      refreshSettings,
      setSettingsBusy,
      setSettingsOpen,
      setOpenRequest,
      settings,
      t,
    ],
  );
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
};

function useSubmitSettingsAction({
  pushStatus,
  setSettings,
  setSettingsBusy,
}: SettingsMutationOptions): (nextSettings: AppSettings) => Promise<void> {
  const { t } = useTranslation("renderer");
  return React.useCallback(
    async (nextSettings) => {
      setSettingsBusy(true);
      try {
        const saved = await mangaGateway.saveSettings(nextSettings);
        setSettings(saved);
        await applySettingsLocale(saved);
        pushStatus(appI18n.t("settings.saved", { ns: "renderer" }));
        toast.success(appI18n.t("settings.savedToast", { ns: "renderer" }));
      } catch (error) {
        // Mirror the success path: the log keeps the record, the toast interrupts.
        const message = formatErrorMessage(error, t("settings.saveFailed"));
        pushStatus(message);
        toast.error(message);
      } finally {
        setSettingsBusy(false);
      }
    },
    [pushStatus, setSettings, setSettingsBusy, t],
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
  setSettingsBusy,
}: Pick<
  SettingsMutationOptions,
  "pushStatus" | "setSettingsBusy"
>): () => Promise<AppSettings | null> {
  const { t } = useTranslation("renderer");
  return React.useCallback(async () => {
    setSettingsBusy(true);
    try {
      const defaults = await mangaGateway.getDefaultSettings();
      pushStatus(t("settings.defaultsLoaded"));
      return defaults;
    } catch (error) {
      const message = formatErrorMessage(error, t("settings.resetFailed"));
      pushStatus(message);
      toast.error(message);
      return null;
    } finally {
      setSettingsBusy(false);
    }
  }, [pushStatus, setSettingsBusy, t]);
}

async function applySettingsLocale(settings: AppSettings): Promise<void> {
  const locale = normalizeUiLocale(settings.ui?.locale);
  if (appI18n.language !== locale) {
    await appI18n.changeLanguage(locale);
  }
}
