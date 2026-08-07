import { dialog } from "electron";
import { randomUUID } from "node:crypto";
import {
  WorkShareExportRequestSchema,
  WorkShareImportRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { importShareIpcContracts } from "../../shared/ipcContracts";
import { runManagedAppOperation } from "../appOperationRegistry";
import type {
  WorkShareExportResult,
  WorkShareImportPreview,
  WorkShareImportPreviewView,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import {
  exportWorkShareToFile,
  importWorkShare,
  listLibrary,
  previewWorkShareImport,
} from "../library";
import {
  getRecentDialogDirectory,
  getRecentDialogFileDefaultPath,
  recentDialogPathKeys,
  rememberRecentDialogFile,
} from "../recentDialogPaths";
import type { IpcContext } from "./context";
import { registerImportPreviewIpc } from "./importPreviewIpc";
import { tMain } from "./localization";
import { prunePreviewSessions } from "./previewSessions";
import { trustedHandleContract } from "./trustedIpc";

export type ImportShareIpcService = {
  exportWorkShareToFile: typeof exportWorkShareToFile;
  importWorkShare: typeof importWorkShare;
  listLibrary: typeof listLibrary;
  previewWorkShareImport: typeof previewWorkShareImport;
};

const productionImportShareIpcService: ImportShareIpcService = {
  exportWorkShareToFile,
  importWorkShare,
  listLibrary,
  previewWorkShareImport,
};

const workSharePreviewSessions = new Map<
  string,
  {
    packagePath: string;
    preview: WorkShareImportPreviewView;
    createdAt: number;
  }
>();

export function registerImportShareIpc(
  context: IpcContext,
  service: ImportShareIpcService = productionImportShareIpcService,
): void {
  registerImportPreviewIpc(context);
  registerExportWorkShareIpc(context, service);
  registerPreviewWorkShareIpc(context, service);
  registerImportWorkShareIpc(context, service);
}

function registerExportWorkShareIpc(
  context: IpcContext,
  service: ImportShareIpcService,
): void {
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
      const library = await service.listLibrary();
      const work = library.works.find(
        (candidate) => candidate.id === request.workId,
      );
      const defaultName = `${sanitizeShareFileName(work?.title ?? "manga-share")}.mgtshare`;
      const options = {
        title: tMain("dialogs.saveShare"),
        defaultPath: getRecentDialogFileDefaultPath(
          context.appPaths.dataRoot,
          recentDialogPathKeys.workShareExport,
          defaultName,
        ),
        filters: [{ name: "Carrot Manga Share", extensions: ["mgtshare"] }],
      } satisfies Electron.SaveDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) {
        return null;
      }
      const outputPath = result.filePath.toLowerCase().endsWith(".mgtshare")
        ? result.filePath
        : `${result.filePath}.mgtshare`;
      const exported = await runManagedAppOperation(
        context.operations,
        {
          id: `work-share-export-${randomUUID()}`,
          kind: "work-share-export",
          mutatesLibrary: false,
        },
        (signal) =>
          service.exportWorkShareToFile(
            {
              ...request,
              outputPath,
            },
            signal,
          ),
      );
      rememberRecentDialogFile(
        context.appPaths.dataRoot,
        recentDialogPathKeys.workShareExport,
        exported.filePath,
      );
      return exported;
    },
  );
}

function registerPreviewWorkShareIpc(
  context: IpcContext,
  service: ImportShareIpcService,
): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewWorkShareImport,
    async (): Promise<WorkShareImportPreview | null> => {
      const options = {
        title: tMain("dialogs.openShare"),
        defaultPath: getRecentDialogDirectory(
          context.appPaths.dataRoot,
          recentDialogPathKeys.workShareImport,
        ),
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
      const preview = await service.previewWorkShareImport(result.filePaths[0]);
      return createWorkSharePreviewSession(result.filePaths[0], preview);
    },
  );
}

function registerImportWorkShareIpc(
  context: IpcContext,
  service: ImportShareIpcService,
): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.importWorkShare,
    async (_event, request: unknown): Promise<WorkShareImportResult> => {
      const command = parseIpcPayload(
        WorkShareImportRequestSchema,
        request,
        tMain("ipc.labels.shareImport"),
      );
      const session = getWorkSharePreviewSession(command.previewId);
      const imported = await runManagedAppOperation(
        context.operations,
        {
          id: `work-share-import-${command.previewId}`,
          kind: "work-share-import",
          mutatesLibrary: true,
        },
        (signal) =>
          service.importWorkShare(
            {
              packagePath: session.packagePath,
              target: command.target,
              entries: command.entries,
            },
            signal,
          ),
      );
      deleteWorkSharePreviewSession(command.previewId);
      rememberRecentDialogFile(
        context.appPaths.dataRoot,
        recentDialogPathKeys.workShareImport,
        session.packagePath,
      );
      return imported;
    },
  );
}

function sanitizeShareFileName(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return cleaned || "manga-share";
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

function getWorkSharePreviewSession(previewId: string): {
  packagePath: string;
  preview: WorkShareImportPreviewView;
} {
  prunePreviewSessions(workSharePreviewSessions);
  const session = workSharePreviewSessions.get(previewId);
  if (!session) {
    throw new Error(tMain("ipc.errors.invalidSharePreview"));
  }
  return session;
}

function deleteWorkSharePreviewSession(previewId: string): void {
  workSharePreviewSessions.delete(previewId);
}
