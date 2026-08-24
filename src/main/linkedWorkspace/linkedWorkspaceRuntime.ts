import type { BrowserWindow } from "electron";
import type { ActiveJobStore } from "../jobs/activeJob";
import type { ImageDecodeFallback } from "../regionCrop";
import { listLibrary, openChapter } from "../library/libraryReadFacade";
import { updatePagesAfterInpainting } from "../library/libraryMutationFacade";
import { createPageExportRenderSession } from "../pageExport";
import { installLinkedWorkspaceSaveNotifier } from "./linkedWorkspaceNotifications";
import { LinkedWorkspaceSyncService } from "./linkedWorkspaceSyncService";

export function createLinkedWorkspaceRuntime(options: {
  dataRoot: string;
  jobs: ActiveJobStore;
  decodeImage: ImageDecodeFallback;
  getMainWindow: () => BrowserWindow | null;
  reportError: (message: string, detail?: unknown) => void;
}) {
  const service = new LinkedWorkspaceSyncService({
    ...options,
    dependencies: {
      listLibrary,
      openChapter,
      updatePagesAfterInpainting,
      createPageExportRenderSession,
    },
  });
  return {
    service,
    installSaveNotifier: () =>
      installLinkedWorkspaceSaveNotifier(
        (chapterId, pageIds) => service.notifyPagesSaved(chapterId, pageIds),
        options.reportError,
      ),
  };
}
