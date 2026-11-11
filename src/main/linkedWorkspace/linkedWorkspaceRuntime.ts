import type { BrowserWindow } from "electron";
import type { ActiveJobStore } from "../jobs/activeJob";
import type { ImageDecodeFallback } from "../regionCrop";
import { listLibrary, openChapter } from "../library/libraryReadFacade";
import { updatePagesAfterInpainting } from "../library/libraryMutationFacade";
import { createPageExportRenderSession } from "../pageExport";
import { installLinkedWorkspaceSaveNotifier } from "./linkedWorkspaceNotifications";
import { LinkedWorkspaceSyncService } from "./linkedWorkspaceSyncService";
import { LinkedWorkspaceStartupCache } from "./linkedWorkspaceStartupCache";
import { getChapterFilePath } from "../libraryStore/libraryPaths";

export function createLinkedWorkspaceRuntime(options: {
  dataRoot: string;
  jobs: ActiveJobStore;
  decodeImage: ImageDecodeFallback;
  getMainWindow: () => BrowserWindow | null;
  reportError: (message: string, detail?: unknown) => void;
}) {
  const service = new LinkedWorkspaceSyncService({
    ...options,
    startupCache: new LinkedWorkspaceStartupCache(
      options.dataRoot,
      getChapterFilePath,
      options.reportError,
    ),
    dependencies: {
      listLibrary,
      openChapter,
      updatePagesAfterInpainting,
      createPageExportRenderSession,
    },
  });
  return {
    service,
    reviewedOutput: service.reviewedOutput,
    installSaveNotifier: () =>
      installLinkedWorkspaceSaveNotifier(
        (chapterId, pageIds, options) =>
          service.notifyPagesSaved(chapterId, pageIds, options),
        options.reportError,
        (target) => service.organizeManagedResults(target),
      ),
  };
}
