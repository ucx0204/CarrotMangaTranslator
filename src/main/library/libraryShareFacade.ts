import type {
  WorkShareExportRequest,
  WorkShareExportResult,
  WorkShareImportFromPackageRequest,
  WorkShareImportResult,
} from "../../shared/shareTypes";
import {
  exportWorkShareToFile as exportWorkShareToFileUnlocked,
  importWorkShareUnlocked,
  previewWorkShareImport,
} from "../libraryStore/shareWorkflow";
import { withLibraryMutation, withLibraryRead } from "./lock";

export { previewWorkShareImport };

export async function importWorkShare(
  request: WorkShareImportFromPackageRequest,
): Promise<WorkShareImportResult> {
  return withLibraryMutation(() => importWorkShareUnlocked(request));
}

export async function exportWorkShareToFile(
  request: WorkShareExportRequest & { outputPath: string },
): Promise<WorkShareExportResult> {
  return withLibraryRead(() => exportWorkShareToFileUnlocked(request));
}
