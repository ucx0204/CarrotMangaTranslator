import { dialog } from "electron";
import { writeFile } from "node:fs/promises";
import {
  SaveTextFileRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { textReviewIpcContracts } from "../../shared/ipcContracts";
import type { SaveTextFileResult } from "../../shared/shareTypes";
import {
  getRecentDialogFileDefaultPath,
  recentDialogPathKeys,
  rememberRecentDialogFile,
} from "../recentDialogPaths";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

function sanitizeTextFileName(name: string): string {
  const base = name
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const safe = base.length > 0 ? base : "manga-text";
  return safe.toLowerCase().endsWith(".txt") ? safe : `${safe}.txt`;
}

export function registerTextExportIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    textReviewIpcContracts.saveTextFile,
    async (_event, rawRequest: unknown): Promise<SaveTextFileResult | null> => {
      const request = parseIpcPayload(
        SaveTextFileRequestSchema,
        rawRequest,
        tMain("ipc.labels.textSave"),
      );
      const defaultName = sanitizeTextFileName(request.defaultName);
      const options = {
        title: tMain("dialogs.saveText"),
        defaultPath: getRecentDialogFileDefaultPath(
          context.appPaths.dataRoot,
          recentDialogPathKeys.plainTextExport,
          defaultName,
        ),
        filters: [{ name: tMain("dialogs.filters.text"), extensions: ["txt"] }],
      } satisfies Electron.SaveDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return null;
      }
      const filePath = result.filePath.toLowerCase().endsWith(".txt")
        ? result.filePath
        : `${result.filePath}.txt`;
      await writeFile(filePath, request.content, "utf8");
      rememberRecentDialogFile(
        context.appPaths.dataRoot,
        recentDialogPathKeys.plainTextExport,
        filePath,
      );
      return { saved: true, path: filePath };
    },
  );
}
