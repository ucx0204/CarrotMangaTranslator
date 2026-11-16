import type { CodexTypesettingPreferences } from "../../../shared/codexTypesettingTypes";
import React from "react";
import { useTranslation } from "react-i18next";
import { normalizeUiLocale } from "../../../shared/uiLocales";
import { appI18n } from "../appI18n";
import type { AppSettings } from "../../../shared/settingsTypes";
import type { ExportPreferences } from "../../../shared/exportPreferences";
import { settingsGateway as mangaGateway } from "../api/settingsGateway";
import { formatErrorMessage } from "../lib/errorPresentation";
import { toast } from "../lib/toastStore";
import { SETTINGS_CREDENTIALS_UNAVAILABLE } from "../../../shared/settingsSecrets";

type UseSettingsDialogResult = {
  saveCodexPreferences?: (
    preferences: CodexTypesettingPreferences,
  ) => Promise<CodexTypesettingPreferences>;
  settings: AppSettings | null;
  settingsOpen: boolean;
  settingsBusy: boolean;
  settingsFailure: string | null;
  recoverCredentials: () => Promise<void>;
  openRequest: SettingsOpenRequest;
  openSettings: (target?: SettingsOpenTarget) => Promise<void>;
  closeSettings: () => void;
  submitSettings: (nextSettings: AppSettings) => Promise<void>;
  resetSettings: () => Promise<AppSettings | null>;
  saveSettingsQuietly: (
    nextSettings: AppSettings,
  ) => Promise<AppSettings | null>;
  /** Resolves false when the newest choice could not be stored. */
  saveExportPreferences: (preferences: ExportPreferences) => Promise<boolean>;
};

type SettingsOpenTarget = "general" | "style-presets";
export type SettingsOpenRequest = {
  revision: number;
  target: SettingsOpenTarget;
};

export function useSettingsDialog(
  pushStatus: (line: string) => void,
): UseSettingsDialogResult {
  const { settings, setSettings, pendingExportRef } = useSettingsState();
  const saveExportPreferences = useExportPreferencesSaveAction(
    setSettings,
    pendingExportRef,
    pushStatus,
  );
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsBusy, setSettingsBusy] = React.useState(false);
  const [settingsFailure, setSettingsFailure] = React.useState<string | null>(
    null,
  );
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
    setSettingsFailure,
    settings,
  });
  const recoverCredentials = useCredentialsRecovery(
    setSettings,
    setSettingsBusy,
    setSettingsFailure,
  );
  const closeSettings = useCloseSettingsAction(settingsBusy, setSettingsOpen);
  const submitSettings = useSubmitSettingsAction({
    pushStatus,
    setSettings,
    setSettingsBusy,
  });
  const saveSettingsQuietly = useQuietSettingsSaveAction(setSettings);
  const saveCodexPreferences = React.useCallback(
    async (preferences: CodexTypesettingPreferences) => {
      const saved =
        await mangaGateway.saveCodexTypesettingPreferences(preferences);
      setSettings((current) =>
        current
          ? {
              ...current,
              ui: { ...current.ui, codexTypesettingPreferences: saved },
            }
          : current,
      );
      return saved;
    },
    [setSettings],
  );
  const resetSettings = useResetSettingsAction({
    pushStatus,
    setSettingsBusy,
  });

  return {
    saveCodexPreferences,
    settings,
    settingsOpen,
    settingsBusy,
    settingsFailure,
    recoverCredentials,
    openRequest,
    openSettings,
    closeSettings,
    submitSettings,
    resetSettings,
    saveSettingsQuietly,
    saveExportPreferences,
  };
}

function useCredentialsRecovery(
  setSettings: React.Dispatch<React.SetStateAction<AppSettings | null>>,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  setFailure: React.Dispatch<React.SetStateAction<string | null>>,
): () => Promise<void> {
  return React.useCallback(async () => {
    setBusy(true);
    try {
      setSettings(await mangaGateway.recoverSettingsCredentials(true));
      setFailure(null);
    } catch (error) {
      setFailure(
        settingsFailureMessage(
          error,
          appI18n.t("settings.loadFailed", { ns: "renderer" }),
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [setSettings, setBusy, setFailure]);
}

function settingsFailureMessage(error: unknown, fallback: string): string {
  return formatErrorMessage(
    error,
    error instanceof Error &&
      error.message.includes(SETTINGS_CREDENTIALS_UNAVAILABLE)
      ? SETTINGS_CREDENTIALS_UNAVAILABLE
      : fallback,
  );
}

function useSettingsState() {
  const [settings, setLoadedSettings] = React.useState<AppSettings | null>(
    null,
  );
  // Full-settings replies may predate even an already acknowledged output choice.
  const pendingExportRef = React.useRef<ExportPreferences | null>(null);
  const setSettings = React.useCallback<
    React.Dispatch<React.SetStateAction<AppSettings | null>>
  >((action) => {
    setLoadedSettings((current) => {
      const next = typeof action === "function" ? action(current) : action;
      const pending = pendingExportRef.current;
      return next && pending ? withExportPreferences(next, pending) : next;
    });
  }, []);
  return { settings, setSettings, pendingExportRef };
}

function withExportPreferences(
  settings: AppSettings,
  exportPreferences: ExportPreferences,
): AppSettings {
  return { ...settings, ui: { ...settings.ui, exportPreferences } };
}

/**
 * Remembers repeatable output choices. Each committed choice is shown at once
 * (so a reopened modal restores it) and sent immediately; the main process
 * applies saves in arrival order, so the newest choice is written last. Only
 * the newest request may settle the in-memory value or report a failure.
 */
function useExportPreferencesSaveAction(
  setSettings: React.Dispatch<React.SetStateAction<AppSettings | null>>,
  pendingRef: React.RefObject<ExportPreferences | null>,
  pushStatus: (line: string) => void,
): (preferences: ExportPreferences) => Promise<boolean> {
  const { t } = useTranslation("renderer");
  const latestRef = React.useRef(0);
  return React.useCallback(
    async (preferences) => {
      const request = ++latestRef.current;
      pendingRef.current = preferences;
      setSettings((current) =>
        current ? withExportPreferences(current, preferences) : current,
      );
      try {
        const saved = await mangaGateway.saveExportPreferences(preferences);
        if (request === latestRef.current) {
          pendingRef.current = saved;
          setSettings((current) =>
            current ? withExportPreferences(current, saved) : current,
          );
        }
        return true;
      } catch (error) {
        if (request !== latestRef.current) return false;
        pendingRef.current = null;
        pushStatus(
          formatErrorMessage(error, t("settings.exportPreferencesSaveFailed")),
        );
        return false;
      }
    },
    [pendingRef, pushStatus, setSettings, t],
  );
}

function useSettingsRefresh(
  setSettings: React.Dispatch<React.SetStateAction<AppSettings | null>>,
): () => Promise<AppSettings> {
  const refresh = React.useCallback(async () => {
    const next = await mangaGateway.getSettings();
    setSettings(next);
    return next;
  }, [setSettings]);
  React.useEffect(() => {
    void refresh().catch((error) => console.error(error));
  }, [refresh]);
  return refresh;
}

type OpenSettingsActionOptions = {
  pushStatus: (line: string) => void;
  refreshSettings: () => Promise<AppSettings>;
  setSettingsBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenRequest: React.Dispatch<React.SetStateAction<SettingsOpenRequest>>;
  setSettingsFailure: React.Dispatch<React.SetStateAction<string | null>>;
  settings: AppSettings | null;
};

function useOpenSettingsAction({
  pushStatus,
  refreshSettings,
  setSettingsBusy,
  setSettingsOpen,
  setOpenRequest,
  setSettingsFailure,
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
        setSettingsFailure(null);
        setSettingsOpen(true);
      } catch (error) {
        setSettingsFailure(
          settingsFailureMessage(error, t("settings.loadFailed")),
        );
        setSettingsOpen(true);
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
      setSettingsFailure,
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
