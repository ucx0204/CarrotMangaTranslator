import { dialog, type OpenDialogOptions } from "electron";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LocalModelPickResult } from "../../shared/jobTypes";
import {
  getRecentDialogDirectory,
  recentDialogPathKeys,
  rememberRecentDialogFile,
  type RecentDialogPathKey,
} from "../recentDialogPaths";
import { inspectVertexServiceAccountFile } from "../vertexServiceAccountAuth";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";
import { settingsIpcContracts } from "../../shared/ipcContextSettingsContracts";

export function registerSettingsFilePickers(context: IpcContext): void {
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
    settingsIpcContracts.pickVertexServiceAccountFile,
    async () => pickVertexServiceAccountFile(context),
  );
}

async function pickLocalModelFile(
  context: IpcContext,
): Promise<LocalModelPickResult | null> {
  const modelPath = await pickGgufFile(
    context,
    tMain("settings.localModelDialogTitle"),
    recentDialogPathKeys.localModel,
  );
  if (!modelPath) return null;
  const detectedMmprojPath = detectSiblingMmprojPath(modelPath);
  return {
    modelPath,
    ...(detectedMmprojPath ? { detectedMmprojPath } : {}),
  };
}

async function pickVertexServiceAccountFile(context: IpcContext) {
  const options = {
    title: tMain("settings.vertexServiceAccountDialogTitle"),
    defaultPath: getRecentDialogDirectory(
      context.appPaths.dataRoot,
      recentDialogPathKeys.vertexServiceAccount,
    ),
    properties: ["openFile"],
    filters: [{ name: "Google service account JSON", extensions: ["json"] }],
  } satisfies OpenDialogOptions;
  const window = context.getMainWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const filePath = result.filePaths[0];
  if (result.canceled || !filePath) return null;
  const inspected = await inspectVertexServiceAccountFile(filePath);
  rememberRecentDialogFile(
    context.appPaths.dataRoot,
    recentDialogPathKeys.vertexServiceAccount,
    filePath,
  );
  return inspected;
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
  } satisfies OpenDialogOptions;
  const window = context.getMainWindow();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  const filePath = result.filePaths[0];
  if (result.canceled || !filePath) return null;
  rememberRecentDialogFile(context.appPaths.dataRoot, recentPathKey, filePath);
  return filePath;
}

function detectSiblingMmprojPath(modelPath: string): string | null {
  const folder = dirname(modelPath);
  if (!existsSync(folder)) return null;
  const preferredNames = [
    "mmproj-BF16.gguf",
    "mmproj-F16.gguf",
    "mmproj-F32.gguf",
    "mmproj.gguf",
  ];
  for (const name of preferredNames) {
    const candidate = join(folder, name);
    if (existsSync(candidate)) return candidate;
  }
  const match = readdirSync(folder, { withFileTypes: true }).find(
    (entry) => entry.isFile() && /^mmproj.*\.gguf$/i.test(entry.name),
  );
  return match ? join(folder, match.name) : null;
}
