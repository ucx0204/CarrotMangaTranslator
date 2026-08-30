import { dialog } from "electron";
import { randomUUID } from "node:crypto";
import {
  CreateImportRequestSchema,
  parseIpcPayload,
} from "../../shared/ipcSchemas";
import { isAppActivityUnavailableError } from "../appActivityGate";
import { runManagedAppOperation } from "../appOperationRegistry";
import { isAbortErrorLike, throwIfAborted } from "../abortSignal";
import type {
  DroppedImportPreviewResponse,
  ImportPreviewSession,
  PreparedImportPreview,
} from "../../shared/importTypes";
import type { DroppedImportSource } from "../library/libraryImportDrop";
import {
  getRecentDialogDirectory,
  recentDialogPathKeys,
  rememberRecentDialogLocation,
  type RecentDialogLocation,
} from "../recentDialogPaths";
import { connectImportedChapters } from "./linkedWorkspaceImport";
import type { IpcContext } from "./context";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";
import { webImportIpcContracts } from "../../shared/ipcWebImportContracts";
import {
  createImportPreviewSession,
  discardImportPreviewSession,
  getImportPreviewSession,
  removeImportPreviewSession,
  runImportPreviewCleanup,
} from "./importPreviewSessionStore";
import {
  createPreparedImportPreviewSession,
  prepareArchiveWithService,
  preparePdfWithService,
  previewHasPages,
  registerContainerImportPreviewIpc,
} from "./importContainerPreviewIpc";
import { importPreviewIpcContracts } from "./importPreviewContracts";
import {
  productionImportPreviewIpcService,
  type ImportPreviewIpcService,
} from "./importPreviewService";

export function registerImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService = productionImportPreviewIpcService,
): void {
  registerImageImportPreviewIpc(context, service);
  registerFolderImportPreviewIpc(context, service);
  registerContainerImportPreviewIpc(context, service);
  registerDroppedImportPreviewIpc(context, service);
  registerCreateImportIpc(context, service);
  registerDiscardImportPreviewIpc(context);
}

function registerImageImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importPreviewIpcContracts.previewImagesImport,
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
      try {
        return await runManagedAppOperation(
          context.operations,
          {
            id: `library-import-preview-${randomUUID()}`,
            kind: "library-import-preview",
            mutatesLibrary: false,
            presentation: {
              phase: "import-source-reading",
              sourceKind: "images",
              cancellable: true,
            },
          },
          async (signal, operation) => {
            const preview = await service.previewImages(result.filePaths);
            throwIfAborted(signal);
            operation.updateActivity({ phase: "import-source-validating" });
            if (!previewHasPages(preview)) {
              throw new Error(tMain("import.errors.noUsablePages"));
            }
            return createImportPreviewSession(preview, {
              key: recentDialogPathKeys.imageImport,
              kind: "file",
              path: result.filePaths[0],
            });
          },
        );
      } catch (error) {
        if (isAbortErrorLike(error)) return null;
        throw error;
      }
    },
  );
}

function registerFolderImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importPreviewIpcContracts.previewFolderImport,
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
      try {
        return await runManagedAppOperation(
          context.operations,
          {
            id: `library-import-preview-${randomUUID()}`,
            kind: "library-import-preview",
            mutatesLibrary: false,
            presentation: {
              phase: "import-source-reading",
              sourceKind: "folder",
              cancellable: true,
            },
          },
          async (signal, operation) => {
            const preview = await service.previewFolder(result.filePaths[0]);
            throwIfAborted(signal);
            operation.updateActivity({ phase: "import-source-validating" });
            if (!previewHasPages(preview)) {
              throw new Error(tMain("import.errors.noUsablePages"));
            }
            return createImportPreviewSession(preview, {
              key: recentDialogPathKeys.imageFolderImport,
              kind: "directory",
              path: result.filePaths[0],
            });
          },
        );
      } catch (error) {
        if (isAbortErrorLike(error)) return null;
        throw error;
      }
    },
  );
}

function registerDroppedImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importPreviewIpcContracts.previewDroppedImport,
    async (_event, filePaths): Promise<DroppedImportPreviewResponse> => {
      try {
        return await runManagedAppOperation(
          context.operations,
          {
            id: `library-import-preview-${randomUUID()}`,
            kind: "library-import-preview",
            mutatesLibrary: false,
            presentation: {
              phase: "import-source-reading",
              cancellable: true,
            },
          },
          async (signal, operation) => {
            const source = await service.classifyDroppedImportPaths(filePaths);
            if (source.status === "rejected") {
              return source;
            }
            operation.updateActivity({
              sourceKind: droppedSourceKind(source),
              phase:
                source.kind === "pdf" || source.kind === "archive"
                  ? "import-source-converting"
                  : "import-source-reading",
            });
            const prepared = await previewDroppedSource(
              source,
              service,
              signal,
            );
            let sessionCreationStarted = false;
            try {
              throwIfAborted(signal);
              operation.updateActivity({ phase: "import-source-validating" });
              sessionCreationStarted = true;
              const session = await createPreparedImportPreviewSession(
                prepared,
                droppedSourceRecentLocation(source),
              );
              if (!session) {
                return emptyDroppedSourceRejection(source);
              }
              return {
                status: "ready",
                preview: session,
              };
            } catch (error) {
              if (!sessionCreationStarted) {
                await runImportPreviewCleanup(prepared.cleanup);
              }
              throw error;
            }
          },
        );
      } catch (error) {
        if (isAppActivityUnavailableError(error)) {
          return { status: "rejected", reason: "busy" };
        }
        if (isAbortErrorLike(error)) {
          return { status: "rejected", reason: "cancelled" };
        }
        throw error;
      }
    },
  );
}

function droppedSourceKind(
  source: Exclude<DroppedImportSource, { status: "rejected" }>,
): PreparedImportPreview["preview"]["sourceKind"] {
  if (source.kind === "archive") {
    return /\.(?:rar|cbr)$/i.test(source.archivePath) ? "rar" : "zip";
  }
  return source.kind;
}

async function previewDroppedSource(
  source: DroppedImportSource,
  service: ImportPreviewIpcService,
  signal?: AbortSignal,
): Promise<PreparedImportPreview> {
  if (source.kind === "images") {
    return { preview: await service.previewImages(source.filePaths) };
  }
  if (source.kind === "folder") {
    return { preview: await service.previewFolder(source.folderPath) };
  }
  if (source.kind === "pdf") {
    return preparePdfWithService(service, source.pdfPath, signal);
  }
  return prepareArchiveWithService(service, source.archivePath, signal);
}

function emptyDroppedSourceRejection(
  source: DroppedImportSource,
): DroppedImportPreviewResponse {
  return {
    status: "rejected",
    reason:
      source.kind === "archive"
        ? "archive-no-images"
        : source.kind === "pdf"
          ? "pdf-no-pages"
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
  if (source.kind === "pdf") {
    return {
      key: recentDialogPathKeys.pdfImport,
      kind: "file",
      path: source.pdfPath,
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
    importPreviewIpcContracts.createImport,
    async (_event, request: unknown) => {
      const command = parseIpcPayload(
        CreateImportRequestSchema,
        request,
        tMain("ipc.labels.importApply"),
      );
      const session = await getImportPreviewSession(command.previewId);
      return runManagedAppOperation(
        context.operations,
        {
          id: `library-import-${command.previewId}`,
          kind: "library-import",
          mutatesLibrary: true,
          presentation: {
            phase: "import-library-writing",
            sourceKind: session.preview.sourceKind,
            cancellable: true,
          },
        },
        async (signal, operation) => {
          const result = await service.createImport(
            {
              preview: session.preview,
              target: command.target,
              selections: command.selections,
            },
            signal,
          );
          operation.updateActivity({
            phase: "import-finalizing",
            cancellable: false,
          });
          const linkedResult = await connectImportedChapters(
            context,
            command,
            result,
          );
          if (session.recentLocation) {
            rememberRecentDialogLocation(
              context.appPaths.dataRoot,
              session.recentLocation,
            );
          }
          removeImportPreviewSession(command.previewId);
          try {
            await runImportPreviewCleanup(session.cleanup);
          } catch (error) {
            // The library transaction already committed; report cleanup separately
            // so a temporary-file failure cannot make the user retry the import.
            context.reportError?.(
              "Imported preview cleanup failed after commit",
              error,
            );
          }
          return { ...result, ...linkedResult };
        },
      );
    },
  );
}

function registerDiscardImportPreviewIpc(context: IpcContext): void {
  trustedHandleContract(
    context,
    webImportIpcContracts.discardImportPreview,
    async (_event, previewId) => ({
      completed: await discardImportPreviewSession(previewId),
    }),
  );
}
