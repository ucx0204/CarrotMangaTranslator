import { dialog, ipcMain } from "electron";
import {
  CreateImportRequestSchema,
  WorkShareExportRequestSchema,
  WorkShareImportRequestSchema,
  parseIpcPayload
} from "../../shared/ipcSchemas";
import type { WorkShareExportResult, WorkShareImportPreview, WorkShareImportResult } from "../../shared/types";
import {
  createImport,
  exportWorkShareToFile,
  importWorkShare,
  listLibrary,
  previewFolder,
  previewImages,
  previewWorkShareImport,
  previewZip,
  previewZipFolder
} from "../library";
import type { IpcContext } from "./context";

export function registerImportShareIpc(context: IpcContext): void {
  ipcMain.handle("import:preview-images", async () => {
    const options = {
      title: "이미지 열기",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
    } satisfies Electron.OpenDialogOptions;
    const window = context.getMainWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const preview = await previewImages(result.filePaths);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-folder", async () => {
    const options = {
      title: "이미지 폴더 열기",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const window = context.getMainWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewFolder(result.filePaths[0]);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-zip", async () => {
    const options = {
      title: "압축파일 열기",
      properties: ["openFile"],
      filters: [{ name: "ZIP Archive", extensions: ["zip"] }]
    } satisfies Electron.OpenDialogOptions;
    const window = context.getMainWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewZip(result.filePaths[0]);
    return preview.chapters[0]?.pages.length ? preview : null;
  });

  ipcMain.handle("import:preview-zip-folder", async () => {
    const options = {
      title: "작품 일괄 번역",
      properties: ["openDirectory"]
    } satisfies Electron.OpenDialogOptions;
    const window = context.getMainWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    const preview = await previewZipFolder(result.filePaths[0]);
    return preview.chapters.length ? preview : null;
  });

  ipcMain.handle("import:create", async (_event, request: unknown) => createImport(parseIpcPayload(CreateImportRequestSchema, request, "가져오기 적용")));

  ipcMain.handle("share:export-work", async (_event, rawRequest: unknown): Promise<WorkShareExportResult | null> => {
    const request = parseIpcPayload(WorkShareExportRequestSchema, rawRequest, "공유 파일 저장");
    const library = await listLibrary();
    const work = library.works.find((candidate) => candidate.id === request.workId);
    const defaultName = `${sanitizeShareFileName(work?.title ?? "manga-share")}.mgtshare`;
    const options = {
      title: "공유 파일 저장",
      defaultPath: defaultName,
      filters: [{ name: "Manga Gemma Share", extensions: ["mgtshare"] }]
    } satisfies Electron.SaveDialogOptions;
    const window = context.getMainWindow();
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) {
      return null;
    }
    return exportWorkShareToFile({
      ...request,
      outputPath: result.filePath.toLowerCase().endsWith(".mgtshare") ? result.filePath : `${result.filePath}.mgtshare`
    });
  });

  ipcMain.handle("share:preview-import", async (): Promise<WorkShareImportPreview | null> => {
    const options = {
      title: "공유 파일 가져오기",
      properties: ["openFile"],
      filters: [{ name: "Manga Gemma Share", extensions: ["mgtshare"] }]
    } satisfies Electron.OpenDialogOptions;
    const window = context.getMainWindow();
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) {
      return null;
    }
    return previewWorkShareImport(result.filePaths[0]);
  });

  ipcMain.handle("share:import", async (_event, request: unknown): Promise<WorkShareImportResult> =>
    importWorkShare(parseIpcPayload(WorkShareImportRequestSchema, request, "공유 파일 가져오기"))
  );
}

function sanitizeShareFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || "manga-share";
}
