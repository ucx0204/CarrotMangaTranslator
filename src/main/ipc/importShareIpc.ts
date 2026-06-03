import { dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import {
  CreateImportRequestSchema,
  WorkShareExportRequestSchema,
  WorkShareImportRequestSchema,
  parseIpcPayload
} from "../../shared/ipcSchemas";
import type {
  ImportPreviewResult,
  ImportPreviewSession,
  WorkShareExportResult,
  WorkShareImportPreview,
  WorkShareImportPreviewView,
  WorkShareImportResult
} from "../../shared/types";
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

const PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEW_SESSIONS = 20;

const importPreviewSessions = new Map<string, { preview: ImportPreviewResult; createdAt: number }>();
const workSharePreviewSessions = new Map<string, { packagePath: string; preview: WorkShareImportPreviewView; createdAt: number }>();

export function registerImportShareIpc(context: IpcContext): void {
  ipcMain.handle("import:preview-images", async (): Promise<ImportPreviewSession | null> => {
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
    return preview.chapters[0]?.pages.length ? createImportPreviewSession(preview) : null;
  });

  ipcMain.handle("import:preview-folder", async (): Promise<ImportPreviewSession | null> => {
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
    return preview.chapters[0]?.pages.length ? createImportPreviewSession(preview) : null;
  });

  ipcMain.handle("import:preview-zip", async (): Promise<ImportPreviewSession | null> => {
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
    return preview.chapters[0]?.pages.length ? createImportPreviewSession(preview) : null;
  });

  ipcMain.handle("import:preview-zip-folder", async (): Promise<ImportPreviewSession | null> => {
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
    return preview.chapters.length ? createImportPreviewSession(preview) : null;
  });

  ipcMain.handle("import:create", async (_event, request: unknown) => {
    const command = parseIpcPayload(CreateImportRequestSchema, request, "가져오기 적용");
    const session = getImportPreviewSession(command.previewId);
    const result = await createImport({
      preview: session.preview,
      target: command.target,
      selections: command.selections
    });
    importPreviewSessions.delete(command.previewId);
    return result;
  });

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
    const preview = await previewWorkShareImport(result.filePaths[0]);
    return createWorkSharePreviewSession(result.filePaths[0], preview);
  });

  ipcMain.handle("share:import", async (_event, request: unknown): Promise<WorkShareImportResult> => {
    const command = parseIpcPayload(WorkShareImportRequestSchema, request, "공유 파일 가져오기");
    const session = consumeWorkSharePreviewSession(command.previewId);
    return importWorkShare({
      packagePath: session.packagePath,
      target: command.target,
      entries: command.entries
    });
  });
}

function sanitizeShareFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || "manga-share";
}

function createImportPreviewSession(preview: ImportPreviewResult): ImportPreviewSession {
  prunePreviewSessions(importPreviewSessions);
  const previewId = randomUUID();
  importPreviewSessions.set(previewId, { preview, createdAt: Date.now() });
  return { previewId, ...preview };
}

function consumeImportPreviewSession(previewId: string): { preview: ImportPreviewResult } {
  const session = getImportPreviewSession(previewId);
  importPreviewSessions.delete(previewId);
  return session;
}

function getImportPreviewSession(previewId: string): { preview: ImportPreviewResult } {
  prunePreviewSessions(importPreviewSessions);
  const session = importPreviewSessions.get(previewId);
  if (!session) {
    throw new Error("만료되었거나 유효하지 않은 가져오기 미리보기입니다.");
  }
  return session;
}

function createWorkSharePreviewSession(packagePath: string, preview: WorkShareImportPreviewView): WorkShareImportPreview {
  prunePreviewSessions(workSharePreviewSessions);
  const previewId = randomUUID();
  workSharePreviewSessions.set(previewId, { packagePath, preview, createdAt: Date.now() });
  return { previewId, ...preview };
}

function consumeWorkSharePreviewSession(previewId: string): { packagePath: string; preview: WorkShareImportPreviewView } {
  prunePreviewSessions(workSharePreviewSessions);
  const session = workSharePreviewSessions.get(previewId);
  if (!session) {
    throw new Error("만료되었거나 유효하지 않은 공유 파일 미리보기입니다.");
  }
  workSharePreviewSessions.delete(previewId);
  return session;
}

function prunePreviewSessions<T>(sessions: Map<string, T & { createdAt: number }>): void {
  const now = Date.now();
  for (const [previewId, session] of sessions) {
    if (now - session.createdAt > PREVIEW_SESSION_TTL_MS) {
      sessions.delete(previewId);
    }
  }
  while (sessions.size > MAX_PREVIEW_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (!oldest) {
      break;
    }
    sessions.delete(oldest);
  }
}
