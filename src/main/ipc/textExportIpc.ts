import { dialog } from "electron";
import { writeFile } from "node:fs/promises";
import {
  SaveTextFileRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { textReviewIpcContracts } from "../../shared/ipcContracts";
import type { SaveTextFileResult } from "../../shared/shareTypes";
import type { IpcContext } from "./context";
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
        "텍스트 저장",
      );
      const options = {
        title: "텍스트 저장",
        defaultPath: sanitizeTextFileName(request.defaultName),
        filters: [{ name: "Text", extensions: ["txt"] }],
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
      return { saved: true, path: filePath };
    },
  );
}
