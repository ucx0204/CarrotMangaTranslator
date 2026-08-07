import { throwIfAborted } from "../abortSignal";
import type {
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportFromPackageRequest,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import {
  importWorkShareUnlocked,
  previewWorkShareImport,
} from "../libraryStore/shareWorkflow";
import { exportWorkShareToFile as exportWorkShareToFileUnlocked } from "../libraryStore/shareExportWorkflow";
import { withLibraryMutation, withLibraryRead } from "./lock";

export { previewWorkShareImport };

export type WorkShareExportRuntime = {
  exportWorkShare: typeof exportWorkShareToFileUnlocked;
  runRead: typeof withLibraryRead;
};

const productionWorkShareExportRuntime: WorkShareExportRuntime = {
  exportWorkShare: exportWorkShareToFileUnlocked,
  runRead: withLibraryRead,
};

export function createWorkShareExport(runtime: WorkShareExportRuntime) {
  return (
    request: WorkShareExportRequest & { outputPath: string },
    signal?: AbortSignal,
  ): Promise<WorkShareExportResult> =>
    runtime.runRead(() => {
      throwIfAborted(signal);
      return runtime.exportWorkShare(request, signal);
    });
}

export const exportWorkShareToFile = createWorkShareExport(
  productionWorkShareExportRuntime,
);

export async function importWorkShare(
  request: WorkShareImportFromPackageRequest,
  signal?: AbortSignal,
): Promise<WorkShareImportResult> {
  return withLibraryMutation(() => {
    throwIfAborted(signal);
    return importWorkShareUnlocked(request, signal);
  });
}
