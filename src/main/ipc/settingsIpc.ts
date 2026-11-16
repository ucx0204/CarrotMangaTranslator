import { BrowserWindow } from "electron";
import { saveExportPreferences } from "../settings/exportPreferencesStore";
import { recoverSettingsCredentials } from "../settingsCredentialRecovery";
import { isSettingsSecretDecryptionError } from "../settingsSecretErrors";
import { registerClaudeAccountIpc } from "./claudeAccountIpc";
import { registerGrokAccountIpc } from "./grokAccountIpc";
import { AppSettingsSchema, parseIpcPayload } from "../../shared/ipcSchemas";
import {
  ipcEventContracts,
  settingsIpcContracts,
} from "../../shared/ipcContracts";
import type { AppSettings } from "../../shared/settingsTypes";
import {
  inferApiProviderPreset,
  type ApiModelDiscoveryRequest,
} from "../../shared/apiProviderPresets";
import {
  SETTINGS_CREDENTIALS_UNAVAILABLE,
  SETTINGS_SECRET_PRESERVE_SENTINEL,
} from "../../shared/settingsSecrets";
import {
  getAppSettings,
  getDefaultAppSettings,
  hydrateAppSettingsSecretSentinels,
  maskAppSettingsSecrets,
  normalizeAppSettingsForRuntime,
  resetAppSettings,
  saveAppSettings,
} from "../settingsStore";
import type { IpcContext } from "./context";
import { handleModelSettingsTest } from "./settingsModelTestIpc";
import type { ModelTestEndpointRuntime } from "./settingsModelTestServer";
import {
  registeredRendererHandleContract,
  trustedHandleContract,
} from "./trustedIpc";
import { getMainLocale, setMainLocale } from "./localization";
import { discoverApiModels } from "../apiModelDiscovery";
import { getTavilyUsage } from "../tavilyClient";
import {
  registerCodexAccountIpc,
  type CodexAccountIpcRuntime,
} from "./codexAccountIpc";
import { registerSettingsFilePickers } from "./settingsFilePickerIpc";

export type SettingsIpcDependencies = {
  modelTestEndpointRuntime?: ModelTestEndpointRuntime;
  normalizeSettingsForRuntime?: typeof normalizeAppSettingsForRuntime;
  codexAccountRuntime?: CodexAccountIpcRuntime;
  getTavilyUsage?: typeof getTavilyUsage;
  getSettings?: typeof getAppSettings;
};

export function registerSettingsIpc(
  context: IpcContext,
  dependencies: SettingsIpcDependencies = {},
): void {
  registerClaudeAccountIpc(context);
  registerGrokAccountIpc(context);
  registerCodexAccountIpc(context, dependencies.codexAccountRuntime);
  registerTavilyUsageIpc(
    context,
    dependencies.getTavilyUsage,
    dependencies.getSettings,
  );
  registeredRendererHandleContract(
    context,
    settingsIpcContracts.getUiLocale,
    async () => getMainLocale(),
  );
  registerSettingsReadWriteIpc(context);
  registerSettingsFilePickers(context);
  registerSettingsModelOperations(context, dependencies);
}

function registerTavilyUsageIpc(
  context: IpcContext,
  usageReader: typeof getTavilyUsage = getTavilyUsage,
  settingsReader: typeof getAppSettings = getAppSettings,
): void {
  trustedHandleContract(
    context,
    settingsIpcContracts.getTavilyUsage,
    async (_event, request = {}) => {
      const submittedKey =
        request.apiKey && request.apiKey !== SETTINGS_SECRET_PRESERVE_SENTINEL
          ? request.apiKey
          : null;
      if (submittedKey) {
        return usageReader(submittedKey, { force: request.force });
      }
      const settings = await settingsReader();
      const apiKey = settings.internetResearch.tavilyApiKey;
      return usageReader(apiKey, { force: request.force });
    },
  );
}

function registerSettingsReadWriteIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    settingsIpcContracts.saveExportPreferences,
    async (_event, preferences) =>
      saveExportPreferences(preferences, context.appPaths),
  );
  trustedHandleContract(context, settingsIpcContracts.getSettings, async () => {
    try {
      return maskAppSettingsSecrets(await getAppSettings(context.appPaths));
    } catch (error) {
      if (isSettingsSecretDecryptionError(error))
        throw new Error(SETTINGS_CREDENTIALS_UNAVAILABLE, { cause: error });
      throw error;
    }
  });
  trustedHandleContract(
    context,
    settingsIpcContracts.recoverSettingsCredentials,
    async (_event, _confirmed: true) => {
      const recovered = await recoverSettingsCredentials(context.appPaths);
      broadcastUiLocale(setMainLocale(recovered.ui?.locale));
      return maskAppSettingsSecrets(recovered);
    },
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.getDefaultSettings,
    async () => maskAppSettingsSecrets(await getDefaultAppSettings()),
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.saveSettings,
    async (_event, settings: unknown) => {
      const saved = await saveAppSettings(
        parseIpcPayload(AppSettingsSchema, settings, "설정 저장"),
      );
      broadcastUiLocale(setMainLocale(saved.ui?.locale));
      return maskAppSettingsSecrets(saved);
    },
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.resetSettings,
    async () => {
      const reset = await resetAppSettings();
      broadcastUiLocale(setMainLocale(reset.ui?.locale));
      return maskAppSettingsSecrets(reset);
    },
  );
}

function registerSettingsModelOperations(
  context: IpcContext,
  dependencies: SettingsIpcDependencies,
): void {
  trustedHandleContract(
    context,
    settingsIpcContracts.testModelSettings,
    async (event, rawSettings: unknown, providedTestId?: unknown) => {
      void ipcEventContracts.modelTestProgress.channel;
      const effectiveSettings = await resolveEffectiveModelTestSettings(
        rawSettings,
        dependencies,
      );
      return handleModelSettingsTest(
        context,
        event,
        effectiveSettings,
        providedTestId,
        dependencies.modelTestEndpointRuntime,
      );
    },
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.discoverApiModels,
    async (_event, request) =>
      discoverApiModelsWithStoredSecret(request, dependencies.getSettings),
  );
}

async function resolveEffectiveModelTestSettings(
  rawSettings: unknown,
  dependencies: SettingsIpcDependencies,
): Promise<AppSettings> {
  const parsed = parseIpcPayload(AppSettingsSchema, rawSettings, "설정 테스트");
  const hydrated = await hydrateAppSettingsSecretSentinels(parsed);
  return (
    dependencies.normalizeSettingsForRuntime ?? normalizeAppSettingsForRuntime
  )(hydrated);
}

async function discoverApiModelsWithStoredSecret(
  request: ApiModelDiscoveryRequest,
  settingsReader: typeof getAppSettings = getAppSettings,
) {
  if (request.apiKey !== SETTINGS_SECRET_PRESERVE_SENTINEL) {
    return discoverApiModels(request);
  }
  const settings = await settingsReader();
  const activeProvider =
    settings.api.provider ?? inferApiProviderPreset(settings.api.baseUrl);
  const storedKey =
    settings.api.profiles?.[request.provider]?.apiKey ??
    (activeProvider === request.provider ? settings.api.apiKey : undefined);
  return discoverApiModels({
    ...request,
    apiKey: storedKey ?? "",
  });
}

function broadcastUiLocale(locale: ReturnType<typeof setMainLocale>): void {
  const payload = ipcEventContracts.uiLocaleChanged.payload.parse(locale);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(
        ipcEventContracts.uiLocaleChanged.channel,
        payload,
      );
    }
  }
}
