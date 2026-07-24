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
  ): Promise<WorkShareExportResult> =>
    runtime.runRead(() => runtime.exportWorkShare(request));
}

export const exportWorkShareToFile = createWorkShareExport(
  productionWorkShareExportRuntime,
);

export async function importWorkShare(
  request: WorkShareImportFromPackageRequest,
): Promise<WorkShareImportResult> {
  return withLibraryMutation(() => importWorkShareUnlocked(request));
}
