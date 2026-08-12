import { dialog } from "electron";
import { randomUUID } from "node:crypto";
import {
  CreateImportRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { importShareIpcContracts } from "../../shared/ipcContracts";
import { SUPPORTED_ARCHIVE_EXTENSIONS } from "../../shared/archive";
import { isAppActivityUnavailableError } from "../appActivityGate";
import { runManagedAppOperation } from "../appOperationRegistry";
import type {
  DroppedImportPreviewResponse,
  ImportPreviewResult,
  ImportPreviewSession,
} from "../../shared/importTypes";
import {
  createImport,
  previewFolder,
  previewImages,
  previewZip,
  previewZipFolder,
} from "../library";
import {
  classifyDroppedImportPaths,
  type DroppedImportSource,
} from "../library/libraryImportDrop";
import {
  getRecentDialogDirectory,
  recentDialogPathKeys,
  rememberRecentDialogLocation,
  type RecentDialogLocation,
} from "../recentDialogPaths";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { prunePreviewSessions } from "./previewSessions";
import { trustedHandleContract } from "./trustedIpc";

const SUPPORTED_ARCHIVE_DIALOG_EXTENSIONS = SUPPORTED_ARCHIVE_EXTENSIONS.map(
  (extension) => extension.slice(1),
);

export type ImportPreviewIpcService = {
  classifyDroppedImportPaths: typeof classifyDroppedImportPaths;
  createImport: typeof createImport;
  previewFolder: typeof previewFolder;
  previewImages: typeof previewImages;
  previewZip: typeof previewZip;
  previewZipFolder: typeof previewZipFolder;
};

const productionImportPreviewIpcService: ImportPreviewIpcService = {
  classifyDroppedImportPaths,
  createImport,
  previewFolder,
  previewImages,
  previewZip,
  previewZipFolder,
};

const importPreviewSessions = new Map<
  string,
  {
    preview: ImportPreviewResult;
    recentLocation: RecentDialogLocation;
    createdAt: number;
  }
>();

export function registerImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService = productionImportPreviewIpcService,
): void {
  registerImageImportPreviewIpc(context, service);
  registerFolderImportPreviewIpc(context, service);
  registerZipImportPreviewIpc(context, service);
  registerZipFolderImportPreviewIpc(context, service);
  registerDroppedImportPreviewIpc(context, service);
  registerCreateImportIpc(context, service);
}

function registerImageImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewImagesImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.openImages"),
        defaultPath: getRecentDialogDirectory(
          context.appPaths.dataRoot,
          recentDialogPathKeys.imageImport,
        ),
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
      const preview = await service.previewImages(result.filePaths);
      return preview.chapters[0]?.pages.length
        ? createImportPreviewSession(preview, {
            key: recentDialogPathKeys.imageImport,
            kind: "file",
            path: result.filePaths[0],
          })
        : null;
    },
  );
}

function registerFolderImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewFolderImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.openImageFolder"),
        defaultPath: getRecentDialogDirectory(
          context.appPaths.dataRoot,
          recentDialogPathKeys.imageFolderImport,
        ),
        properties: ["openDirectory"],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      const preview = await service.previewFolder(result.filePaths[0]);
      return preview.chapters[0]?.pages.length
        ? createImportPreviewSession(preview, {
            key: recentDialogPathKeys.imageFolderImport,
            kind: "directory",
            path: result.filePaths[0],
          })
        : null;
    },
  );
}

function registerZipImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewZipImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.openArchive"),
        defaultPath: getRecentDialogDirectory(
          context.appPaths.dataRoot,
          recentDialogPathKeys.archiveImport,
        ),
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
      const preview = await service.previewZip(result.filePaths[0]);
      return preview.chapters[0]?.pages.length
        ? createImportPreviewSession(preview, {
            key: recentDialogPathKeys.archiveImport,
            kind: "file",
            path: result.filePaths[0],
          })
        : null;
    },
  );
}

function registerZipFolderImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewZipFolderImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.batchImport"),
        defaultPath: getRecentDialogDirectory(
          context.appPaths.dataRoot,
          recentDialogPathKeys.archiveFolderImport,
        ),
        properties: ["openDirectory"],
      } satisfies Electron.OpenDialogOptions;
      const window = context.getMainWindow();
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      const preview = await service.previewZipFolder(result.filePaths[0]);
      return preview.chapters.length
        ? createImportPreviewSession(preview, {
            key: recentDialogPathKeys.archiveFolderImport,
            kind: "directory",
            path: result.filePaths[0],
          })
        : null;
    },
  );
}

function registerDroppedImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importShareIpcContracts.previewDroppedImport,
    async (_event, filePaths): Promise<DroppedImportPreviewResponse> => {
      try {
        return await runManagedAppOperation(
          context.operations,
          {
            id: `library-import-preview-${randomUUID()}`,
            kind: "library-import-preview",
            mutatesLibrary: false,
          },
          async () => {
            const source = await service.classifyDroppedImportPaths(filePaths);
            if (source.status === "rejected") {
              return source;
            }
            const preview = await previewDroppedSource(source, service);
            if (!previewHasPages(preview)) {
              return emptyDroppedSourceRejection(source);
            }
            return {
              status: "ready",
              preview: createImportPreviewSession(
                preview,
                droppedSourceRecentLocation(source),
              ),
            };
          },
        );
      } catch (error) {
        if (isAppActivityUnavailableError(error)) {
          return { status: "rejected", reason: "busy" };
        }
        throw error;
      }
    },
  );
}

async function previewDroppedSource(
  source: DroppedImportSource,
  service: ImportPreviewIpcService,
): Promise<ImportPreviewResult> {
  if (source.kind === "images") {
    return service.previewImages(source.filePaths);
  }
  if (source.kind === "folder") {
    return service.previewFolder(source.folderPath);
  }
  return service.previewZip(source.archivePath);
}

function previewHasPages(preview: ImportPreviewResult): boolean {
  return preview.chapters.some((chapter) => chapter.pages.length > 0);
}

function emptyDroppedSourceRejection(
  source: DroppedImportSource,
): DroppedImportPreviewResponse {
  return {
    status: "rejected",
    reason:
      source.kind === "archive"
        ? "archive-no-images"
        : source.kind === "folder"
          ? "folder-no-images"
          : "empty",
  };
}

function droppedSourceRecentLocation(
  source: DroppedImportSource,
): RecentDialogLocation {
  if (source.kind === "images") {
    return {
      key: recentDialogPathKeys.imageImport,
      kind: "file",
      path: source.filePaths[0],
    };
  }
  if (source.kind === "folder") {
    return {
      key: recentDialogPathKeys.imageFolderImport,
      kind: "directory",
      path: source.folderPath,
    };
  }
  return {
    key: recentDialogPathKeys.archiveImport,
    kind: "file",
    path: source.archivePath,
  };
}

function registerCreateImportIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
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
      const result = await runManagedAppOperation(
        context.operations,
        {
          id: `library-import-${command.previewId}`,
          kind: "library-import",
          mutatesLibrary: true,
        },
        (signal) =>
          service.createImport(
            {
              preview: session.preview,
              target: command.target,
              selections: command.selections,
            },
            signal,
          ),
      );
      rememberRecentDialogLocation(
        context.appPaths.dataRoot,
        session.recentLocation,
      );
      importPreviewSessions.delete(command.previewId);
      return result;
    },
  );
}

function createImportPreviewSession(
  preview: ImportPreviewResult,
  recentLocation: RecentDialogLocation,
): ImportPreviewSession {
  prunePreviewSessions(importPreviewSessions);
  const previewId = randomUUID();
  importPreviewSessions.set(previewId, {
    preview,
    recentLocation,
    createdAt: Date.now(),
  });
  return { previewId, ...preview };
}

function getImportPreviewSession(previewId: string): {
  preview: ImportPreviewResult;
  recentLocation: RecentDialogLocation;
} {
  prunePreviewSessions(importPreviewSessions);
  const session = importPreviewSessions.get(previewId);
  if (!session) {
    throw new Error(tMain("ipc.errors.invalidImportPreview"));
  }
  return session;
}
