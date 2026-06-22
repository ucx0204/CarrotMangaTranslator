import { dialog } from "electron";
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
import { handleModelSettingsTest } from "./settingsModelTestIpc";
import { trustedHandleContract } from "./trustedIpc";

export function registerSettingsIpc(context: IpcContext): void {
  trustedHandleContract(context, settingsIpcContracts.getSettings, async () =>
    getAppSettings(),
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.saveSettings,
    async (_event, settings: unknown) =>
      saveAppSettings(
        parseIpcPayload(AppSettingsSchema, settings, "설정 저장"),
      ),
  );
  trustedHandleContract(context, settingsIpcContracts.resetSettings, async () =>
    resetAppSettings(),
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.pickLocalModelFile,
    async (): Promise<LocalModelPickResult | null> => {
      const options = {
        title: "로컬 GGUF 모델 선택",
        properties: ["openFile"],
        filters: [{ name: "GGUF Model", extensions: ["gguf"] }],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }

      const modelPath = result.filePaths[0];
      const detectedMmprojPath = detectSiblingMmprojPath(modelPath);
      return {
        modelPath,
        ...(detectedMmprojPath ? { detectedMmprojPath } : {}),
      };
    },
  );
  trustedHandleContract(
    context,
    settingsIpcContracts.pickLocalMmprojFile,
    async (): Promise<string | null> => {
      const options = {
        title: "mmproj 파일 선택",
        properties: ["openFile"],
        filters: [{ name: "GGUF Model", extensions: ["gguf"] }],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      return result.filePaths[0];
    },
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
      );
    },
  );
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
