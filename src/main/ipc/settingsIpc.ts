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
import {
  getAppSettings,
  resetAppSettings,
  saveAppSettings,
} from "../settingsStore";
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
    getAppSettings(),
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.saveSettings,
    async (_event, settings: unknown) => {
      const saved = await saveAppSettings(
        parseIpcPayload(AppSettingsSchema, settings, "설정 저장"),
      );
      broadcastUiLocale(setMainLocale(saved.ui?.locale));
      return saved;
    },
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.resetSettings,
    async () => {
      const reset = await resetAppSettings();
      broadcastUiLocale(setMainLocale(reset.ui?.locale));
      return reset;
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
    async () => pickGgufFile(context, tMain("settings.mmprojDialogTitle")),
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.testModelSettings,
    async (event, rawSettings: unknown, providedTestId?: unknown) => {
      void ipcEventContracts.modelTestProgress.channel;
      return handleModelSettingsTest(
        context,
        event,
        rawSettings,
        providedTestId,
        dependencies.modelTestEndpointRuntime,
      );
    },
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.discoverApiModels,
    async (_event, request) => discoverApiModels(request),
  );
}

async function pickLocalModelFile(
  context: IpcContext,
): Promise<LocalModelPickResult | null> {
  const modelPath = await pickGgufFile(
    context,
    tMain("settings.localModelDialogTitle"),
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
): Promise<string | null> {
  const options = {
    title,
    properties: ["openFile"],
    filters: [{ name: "GGUF Model", extensions: ["gguf"] }],
  } satisfies Electron.OpenDialogOptions;
  const window = context.getMainWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
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
