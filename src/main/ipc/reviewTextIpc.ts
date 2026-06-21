import { dialog } from "electron";
import { writeFile } from "node:fs/promises";
import {
  ExportReviewTextRequestSchema,
  ImportReviewTextRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { buildReviewRows, serializeReviewRows } from "../../shared/reviewTable";
import type { SaveTextFileResult } from "../../shared/types";
import { importReviewText, openChapter } from "../library";
import type { IpcContext } from "./context";
import { trustedHandle } from "./trustedIpc";

export function registerReviewTextIpc(context: IpcContext): void {
  trustedHandle(
    context,
    "review:export-text",
    async (_event, raw: unknown): Promise<SaveTextFileResult | null> => {
      const request = parseIpcPayload(
        ExportReviewTextRequestSchema,
        raw,
        "검수표 내보내기",
      );
      const chapter = await openChapter(request.chapterId);
      const content = serializeReviewRows(
        buildReviewRows(chapter),
        request.format,
        request.includeBom ?? true,
      );
      const options = {
        title: "검수표 저장",
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

  trustedHandle(context, "review:import-text", async (_event, raw: unknown) =>
    importReviewText(
      parseIpcPayload(ImportReviewTextRequestSchema, raw, "검수표 가져오기"),
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
