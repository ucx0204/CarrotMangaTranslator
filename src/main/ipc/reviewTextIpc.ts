import { dialog } from "electron";
import { writeFile } from "node:fs/promises";
import {
  ExportReviewTextRequestSchema,
  ImportReviewTextRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { textReviewIpcContracts } from "../../shared/ipcContracts";
import { buildReviewRows, serializeReviewRows } from "../../shared/reviewTable";
import type { SaveTextFileResult } from "../../shared/shareTypes";
import { resolveSourceReadingDirection } from "../../shared/translationLanguages";
import { importReviewText, openChapter } from "../library";
import { getAppSettings } from "../settingsStore";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

export function registerReviewTextIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    textReviewIpcContracts.exportReviewText,
    async (_event, raw: unknown): Promise<SaveTextFileResult | null> => {
      const request = parseIpcPayload(
        ExportReviewTextRequestSchema,
        raw,
        tMain("ipc.labels.reviewExport"),
      );
      const chapter = await openChapter(request.chapterId);
      const settings = await getAppSettings();
      const content = serializeReviewRows(
        buildReviewRows(
          chapter,
          resolveSourceReadingDirection(settings.translation?.sourceLanguage),
        ),
        request.format,
        request.includeBom ?? true,
      );
      const options = {
        title: tMain("dialogs.saveReview"),
        defaultPath: sanitizeReviewFileName(chapter.title, request.format),
        filters: [
          {
            name: request.format.toUpperCase(),
            extensions: [request.format],
          },
        ],
      } satisfies Electron.SaveDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return null;
      }
      const filePath = ensureExtension(result.filePath, request.format);
      await writeFile(filePath, content, "utf8");
      return { saved: true, path: filePath };
    },
  );

  trustedHandleContract(
    context,
    textReviewIpcContracts.importReviewText,
    async (_event, raw: unknown) =>
      importReviewText(
        parseIpcPayload(
          ImportReviewTextRequestSchema,
          raw,
          tMain("ipc.labels.reviewImport"),
        ),
      ),
  );
}

function sanitizeReviewFileName(title: string, format: "csv" | "tsv"): string {
  const base = title
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return `${base || "manga-review"}.${format}`;
}

function ensureExtension(path: string, format: "csv" | "tsv"): string {
  return path.toLowerCase().endsWith(`.${format}`) ? path : `${path}.${format}`;
}
