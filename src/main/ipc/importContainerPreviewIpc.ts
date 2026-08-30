import { dialog } from "electron";
import { randomUUID } from "node:crypto";
import { SUPPORTED_ARCHIVE_EXTENSIONS } from "../../shared/archive";
import type {
  ImportPreviewResult,
  ImportPreviewSession,
  PreparedImportPreview,
} from "../../shared/importTypes";
import {
  getRecentDialogDirectory,
  recentDialogPathKeys,
  type RecentDialogLocation,
} from "../recentDialogPaths";
import type { IpcContext } from "./context";
import {
  createImportPreviewSession,
  runImportPreviewCleanup,
} from "./importPreviewSessionStore";
import { importPreviewIpcContracts } from "./importPreviewContracts";
import type { ImportPreviewIpcService } from "./importPreviewService";
import { tMain } from "./localization";
import { trustedHandleContract } from "./trustedIpc";
import { runManagedAppOperation } from "../appOperationRegistry";
import { isAbortErrorLike, throwIfAborted } from "../abortSignal";
import type { ImportSourceProgress } from "../library";

const SUPPORTED_ARCHIVE_DIALOG_EXTENSIONS = SUPPORTED_ARCHIVE_EXTENSIONS.map(
  (extension) => extension.slice(1),
);

export function registerContainerImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  registerArchiveImportPreviewIpc(context, service);
  registerPdfImportPreviewIpc(context, service);
  registerArchiveFolderImportPreviewIpc(context, service);
}

function registerArchiveImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importPreviewIpcContracts.previewZipImport,
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
            name: "ZIP/CBZ/RAR/CBR Archive",
            extensions: SUPPORTED_ARCHIVE_DIALOG_EXTENSIONS,
          },
        ],
      } satisfies Electron.OpenDialogOptions;
      const result = await showOpenDialog(context, options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      const archivePath = result.filePaths[0];
      const sourceKind = /\.(?:rar|cbr)$/i.test(archivePath) ? "rar" : "zip";
      return runContainerPreviewOperation(
        context,
        sourceKind,
        sourceKind === "rar"
          ? "import-source-converting"
          : "import-source-reading",
        (signal, onProgress) =>
          prepareArchiveWithService(service, archivePath, signal, onProgress),
        {
          key: recentDialogPathKeys.archiveImport,
          kind: "file",
          path: archivePath,
        },
      );
    },
  );
}

function registerPdfImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importPreviewIpcContracts.previewPdfImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.openPdf"),
        defaultPath: getRecentDialogDirectory(
          context.appPaths.dataRoot,
          recentDialogPathKeys.pdfImport,
        ),
        properties: ["openFile"],
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      } satisfies Electron.OpenDialogOptions;
      const result = await showOpenDialog(context, options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      const pdfPath = result.filePaths[0];
      return runContainerPreviewOperation(
        context,
        "pdf",
        "import-source-converting",
        (signal, onProgress) =>
          preparePdfWithService(service, pdfPath, signal, onProgress),
        {
          key: recentDialogPathKeys.pdfImport,
          kind: "file",
          path: pdfPath,
        },
      );
    },
  );
}

function registerArchiveFolderImportPreviewIpc(
  context: IpcContext,
  service: ImportPreviewIpcService,
): void {
  trustedHandleContract(
    context,
    importPreviewIpcContracts.previewZipFolderImport,
    async (): Promise<ImportPreviewSession | null> => {
      const options = {
        title: tMain("dialogs.batchImport"),
        defaultPath: getRecentDialogDirectory(
          context.appPaths.dataRoot,
          recentDialogPathKeys.archiveFolderImport,
        ),
        properties: ["openDirectory"],
      } satisfies Electron.OpenDialogOptions;
      const result = await showOpenDialog(context, options);
      if (result.canceled || !result.filePaths[0]) {
        return null;
      }
      const folderPath = result.filePaths[0];
      return runContainerPreviewOperation(
        context,
        "zip-folder",
        "import-source-converting",
        (signal, onProgress) =>
          prepareArchiveFolderWithService(
            service,
            folderPath,
            signal,
            onProgress,
          ),
        {
          key: recentDialogPathKeys.archiveFolderImport,
          kind: "directory",
          path: folderPath,
        },
      );
    },
  );
}

async function runContainerPreviewOperation(
  context: IpcContext,
  sourceKind: ImportPreviewResult["sourceKind"],
  phase: "import-source-reading" | "import-source-converting",
  prepare: (
    signal: AbortSignal,
    onProgress: (progress: ImportSourceProgress) => void,
  ) => Promise<PreparedImportPreview>,
  recentLocation: RecentDialogLocation,
): Promise<ImportPreviewSession | null> {
  try {
    return await runManagedAppOperation(
      context.operations,
      {
        id: `library-import-preview-${randomUUID()}`,
        kind: "library-import-preview",
        mutatesLibrary: false,
        presentation: { phase, sourceKind, cancellable: true },
      },
      async (signal, operation) => {
        const prepared = await prepare(signal, (progress) =>
          operation.updateActivity({
            phase: "import-source-converting",
            progressCurrent: progress.current,
            progressTotal: progress.total,
            progressUnit: "items",
          }),
        );
        let sessionCreationStarted = false;
        try {
          throwIfAborted(signal);
          operation.updateActivity({
            phase: "import-source-validating",
            sourceKind: prepared.preview.sourceKind,
          });
          sessionCreationStarted = true;
          const session = await createPreparedImportPreviewSession(
            prepared,
            recentLocation,
          );
          if (!session) {
            throw new Error(tMain("import.errors.noUsablePages"));
          }
          return session;
        } catch (error) {
          if (!sessionCreationStarted) {
            await runImportPreviewCleanup(prepared.cleanup);
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (isAbortErrorLike(error)) return null;
    throw error;
  }
}

function showOpenDialog(
  context: IpcContext,
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  const window = context.getMainWindow();
  return window
    ? dialog.showOpenDialog(window, options)
    : dialog.showOpenDialog(options);
}

export async function prepareArchiveWithService(
  service: ImportPreviewIpcService,
  archivePath: string,
  signal?: AbortSignal,
  onProgress?: (progress: ImportSourceProgress) => void,
): Promise<PreparedImportPreview> {
  if (service.prepareArchiveImportPreview) {
    return service.prepareArchiveImportPreview(archivePath, signal, onProgress);
  }
  return { preview: await service.previewZip(archivePath) };
}

async function prepareArchiveFolderWithService(
  service: ImportPreviewIpcService,
  folderPath: string,
  signal?: AbortSignal,
  onProgress?: (progress: ImportSourceProgress) => void,
): Promise<PreparedImportPreview> {
  if (service.prepareArchiveFolderImportPreview) {
    return service.prepareArchiveFolderImportPreview(
      folderPath,
      signal,
      onProgress,
    );
  }
  return { preview: await service.previewZipFolder(folderPath) };
}

export async function preparePdfWithService(
  service: ImportPreviewIpcService,
  pdfPath: string,
  signal?: AbortSignal,
  onProgress?: (progress: ImportSourceProgress) => void,
): Promise<PreparedImportPreview> {
  if (!service.preparePdfImportPreview) {
    throw new Error("PDF 가져오기 서비스를 사용할 수 없습니다.");
  }
  return service.preparePdfImportPreview(pdfPath, signal, onProgress);
}

export function previewHasPages(preview: ImportPreviewResult): boolean {
  return preview.chapters.some((chapter) => chapter.pages.length > 0);
}

export async function createPreparedImportPreviewSession(
  prepared: PreparedImportPreview,
  recentLocation: RecentDialogLocation,
): Promise<ImportPreviewSession | null> {
  if (!previewHasPages(prepared.preview)) {
    await runImportPreviewCleanup(prepared.cleanup);
    return null;
  }
  try {
    return await createImportPreviewSession(prepared.preview, recentLocation, {
      cleanup: prepared.cleanup,
    });
  } catch (error) {
    await runImportPreviewCleanup(prepared.cleanup);
    throw error;
  }
}
