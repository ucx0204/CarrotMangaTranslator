import { dialog } from "electron";
import { randomUUID } from "node:crypto";
import {
  CreateImportRequestSchema,
  WorkShareExportRequestSchema,
  WorkShareImportRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { importShareIpcContracts } from "../../shared/ipcContracts";
import { SUPPORTED_ARCHIVE_EXTENSIONS } from "../../shared/archive";
import type {
  ImportPreviewResult,
  ImportPreviewSession,
} from "../../shared/importTypes";
import type {
  WorkShareExportResult,
  WorkShareImportPreview,
  WorkShareImportPreviewView,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import {
  createImport,
  exportWorkShareToFile,
  importWorkShare,
  listLibrary,
  previewFolder,
  previewImages,
  previewWorkShareImport,
  previewZip,
  previewZipFolder,
} from "../library";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";

const PREVIEW_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEW_SESSIONS = 20;
const SUPPORTED_ARCHIVE_DIALOG_EXTENSIONS = SUPPORTED_ARCHIVE_EXTENSIONS.map(
  (extension) => extension.slice(1),
);

const importPreviewSessions = new Map<
  string,
  { preview: ImportPreviewResult; createdAt: number }
>();
const workSharePreviewSessions = new Map<
  string,
  {
    packagePath: string;
    preview: WorkShareImportPreviewView;
    createdAt: number;
  }
>();

export function registerImportShareIpc(context: IpcContext): void {
  registerImageImportPreviewIpc(context);
  registerFolderImportPreviewIpc(context);
  registerZipImportPreviewIpc(context);
  registerZipFolderImportPreviewIpc(context);
  registerCreateImportIpc(context);
  registerExportWorkShareIpc(context);
  registerPreviewWorkShareIpc(context);
  registerImportWorkShareIpc(context);
}

function registerImageImportPreviewIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewImagesImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.openImages"),
        properties: ["openFile", "multiSelections"],
        filters: [
          {
            name: tMain("dialogs.filters.images"),
            extensions: ["png", "jpg", "jpeg", "webp"],
          },
        ],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const preview = await previewImages(result.filePaths);
      return preview.chapters[0]?.pages.length
        ? createImportPreviewSession(preview)
        : null;
    },
  );
}

function registerFolderImportPreviewIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewFolderImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.openImageFolder"),
        properties: ["openDirectory"],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      const preview = await previewFolder(result.filePaths[0]);
      return preview.chapters[0]?.pages.length
        ? createImportPreviewSession(preview)
        : null;
    },
  );
}

function registerZipImportPreviewIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewZipImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.openArchive"),
        properties: ["openFile"],
        filters: [
          {
            name: "ZIP/CBZ Archive",
            extensions: SUPPORTED_ARCHIVE_DIALOG_EXTENSIONS,
          },
        ],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      const preview = await previewZip(result.filePaths[0]);
      return preview.chapters[0]?.pages.length
        ? createImportPreviewSession(preview)
        : null;
    },
  );
}

function registerZipFolderImportPreviewIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewZipFolderImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.batchImport"),
        properties: ["openDirectory"],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      const preview = await previewZipFolder(result.filePaths[0]);
      return preview.chapters.length
        ? createImportPreviewSession(preview)
        : null;
    },
  );
}

function registerCreateImportIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.createImport,
    async (_event, request: unknown) => {
      const command = parseIpcPayload(
        CreateImportRequestSchema,
        request,
        tMain("ipc.labels.importApply"),
      );
      const session = getImportPreviewSession(command.previewId);
      const result = await createImport({
        preview: session.preview,
        target: command.target,
        selections: command.selections,
      });
      importPreviewSessions.delete(command.previewId);
      return result;
    },
  );
}

function registerExportWorkShareIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.exportWorkShare,
    async (
      _event,
      rawRequest: unknown,
    ): Promise<WorkShareExportResult | null> => {
      const request = parseIpcPayload(
        WorkShareExportRequestSchema,
        rawRequest,
        tMain("ipc.labels.shareSave"),
      );
      const library = await listLibrary();
      const work = library.works.find(
        (candidate) => candidate.id === request.workId,
      );
      const defaultName = `${sanitizeShareFileName(work?.title ?? "manga-share")}.mgtshare`;
      const options = {
        title: tMain("dialogs.saveShare"),
        defaultPath: defaultName,
        filters: [{ name: "Carrot Manga Share", extensions: ["mgtshare"] }],
      } satisfies Electron.SaveDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return null;
      }
      return exportWorkShareToFile({
        ...request,
        outputPath: result.filePath.toLowerCase().endsWith(".mgtshare")
          ? result.filePath
          : `${result.filePath}.mgtshare`,
      });
    },
  );
}

function registerPreviewWorkShareIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewWorkShareImport,
    async (): Promise<WorkShareImportPreview | null> => {
      const options = {
        title: tMain("dialogs.openShare"),
        properties: ["openFile"],
        filters: [{ name: "Carrot Manga Share", extensions: ["mgtshare"] }],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      const preview = await previewWorkShareImport(result.filePaths[0]);
      return createWorkSharePreviewSession(result.filePaths[0], preview);
    },
  );
}

function registerImportWorkShareIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.importWorkShare,
    async (_event, request: unknown): Promise<WorkShareImportResult> => {
      const command = parseIpcPayload(
        WorkShareImportRequestSchema,
        request,
        tMain("ipc.labels.shareImport"),
      );
      const session = consumeWorkSharePreviewSession(command.previewId);
      return importWorkShare({
        packagePath: session.packagePath,
        target: command.target,
        entries: command.entries,
      });
    },
  );
}

function sanitizeShareFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || "manga-share";
}

function createImportPreviewSession(
  preview: ImportPreviewResult,
): ImportPreviewSession {
  prunePreviewSessions(importPreviewSessions);
  const previewId = randomUUID();
  importPreviewSessions.set(previewId, { preview, createdAt: Date.now() });
  return { previewId, ...preview };
}

function getImportPreviewSession(previewId: string): {
  preview: ImportPreviewResult;
} {
  prunePreviewSessions(importPreviewSessions);
  const session = importPreviewSessions.get(previewId);
  if (!session) {
    throw new Error(tMain("ipc.errors.invalidImportPreview"));
  }
  return session;
}

function createWorkSharePreviewSession(
  packagePath: string,
  preview: WorkShareImportPreviewView,
): WorkShareImportPreview {
  prunePreviewSessions(workSharePreviewSessions);
  const previewId = randomUUID();
  workSharePreviewSessions.set(previewId, {
    packagePath,
    preview,
    createdAt: Date.now(),
  });
  return { previewId, ...preview };
}

function consumeWorkSharePreviewSession(previewId: string): {
  packagePath: string;
  preview: WorkShareImportPreviewView;
} {
  prunePreviewSessions(workSharePreviewSessions);
  const session = workSharePreviewSessions.get(previewId);
  if (!session) {
    throw new Error(tMain("ipc.errors.invalidSharePreview"));
  }
  workSharePreviewSessions.delete(previewId);
  return session;
}

function prunePreviewSessions<T>(
  sessions: Map<string, T & { createdAt: number }>,
): void {
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
