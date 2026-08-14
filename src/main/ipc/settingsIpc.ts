import { BrowserWindow, dialog } from "electron";
import { readdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppSettingsSchema, parseIpcPayload } from "../../shared/ipcSchemas";
import {
  ipcEventContracts,
  settingsIpcContracts,
} from "../../shared/ipcContracts";
import type { LocalModelPickResult } from "../../shared/jobTypes";
import type { AppSettings } from "../../shared/settingsTypes";
import type { ApiModelDiscoveryRequest } from "../../shared/apiProviderPresets";
import { SETTINGS_SECRET_PRESERVE_SENTINEL } from "../../shared/settingsSecrets";
import {
  getAppSettings,
  getDefaultAppSettings,
  hydrateAppSettingsSecretSentinels,
  maskAppSettingsSecrets,
  normalizeAppSettingsForRuntime,
  resetAppSettings,
  saveAppSettings,
} from "../settingsStore";
import {
  getRecentDialogDirectory,
  recentDialogPathKeys,
  rememberRecentDialogFile,
  type RecentDialogPathKey,
} from "../recentDialogPaths";
import type { IpcContext } from "./context";
import {
  handleModelSettingsTest,
  type ModelTestEndpointRuntime,
} from "./settingsModelTestIpc";
import {
  registeredRendererHandleContract,
  trustedHandleContract,
} from "./trustedIpc";
import { getMainLocale, setMainLocale, tMain } from "./localization";
import { discoverApiModels } from "../apiModelDiscovery";

export type SettingsIpcDependencies = {
  modelTestEndpointRuntime?: ModelTestEndpointRuntime;
  normalizeSettingsForRuntime?: typeof normalizeAppSettingsForRuntime;
};

export function registerSettingsIpc(
  context: IpcContext,
  dependencies: SettingsIpcDependencies = {},
): void {
  registeredRendererHandleContract(
    context,
    settingsIpcContracts.getUiLocale,
    async () => getMainLocale(),
  );
  trustedHandleContract(context, settingsIpcContracts.getSettings, async () =>
    maskAppSettingsSecrets(await getAppSettings()),
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
  trustedHandleContract(
    context,
    settingsIpcContracts.pickLocalModelFile,
    async () => pickLocalModelFile(context),
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.pickLocalMmprojFile,
    async () =>
      pickGgufFile(
        context,
        tMain("settings.mmprojDialogTitle"),
        recentDialogPathKeys.localMmproj,
      ),
  );
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
    async (_event, request) => discoverApiModelsWithStoredSecret(request),
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
) {
  if (request.apiKey !== SETTINGS_SECRET_PRESERVE_SENTINEL) {
    return discoverApiModels(request);
  }
  const settings = await getAppSettings();
  return discoverApiModels({
    ...request,
    apiKey: settings.api.apiKey ?? "",
  });
}

async function pickLocalModelFile(
  context: IpcContext,
): Promise<LocalModelPickResult | null> {
  const modelPath = await pickGgufFile(
    context,
    tMain("settings.localModelDialogTitle"),
    recentDialogPathKeys.localModel,
  );
  if (!modelPath) {
    return null;
  }
  const detectedMmprojPath = detectSiblingMmprojPath(modelPath);
  return {
    modelPath,
    ...(detectedMmprojPath ? { detectedMmprojPath } : {}),
  };
}

async function pickGgufFile(
  context: IpcContext,
  title: string,
  recentPathKey: RecentDialogPathKey,
): Promise<string | null> {
  const options = {
    title,
    defaultPath: getRecentDialogDirectory(
      context.appPaths.dataRoot,
      recentPathKey,
    ),
    properties: ["openFile"],
    filters: [{ name: "GGUF Model", extensions: ["gguf"] }],
  } satisfies Electron.OpenDialogOptions;
  const window = context.getMainWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const filePath = result.filePaths[0];
  if (result.canceled || !filePath) {
    return null;
  }
  rememberRecentDialogFile(context.appPaths.dataRoot, recentPathKey, filePath);
  return filePath;
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

function detectSiblingMmprojPath(modelPath: string): string | null {
  const folder = dirname(modelPath);
  if (!existsSync(folder)) {
    return null;
  }

  const preferredNames = [
    "mmproj-BF16.gguf",
    "mmproj-F16.gguf",
    "mmproj-F32.gguf",
    "mmproj.gguf",
  ];
  for (const name of preferredNames) {
    const candidate = join(folder, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const match = readdirSync(folder, { withFileTypes: true }).find(
    (entry) => entry.isFile() && /^mmproj.*\.gguf$/i.test(entry.name),
  );
  return match ? join(folder, match.name) : null;
}
