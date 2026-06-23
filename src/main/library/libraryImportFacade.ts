import type {
  CreateImportFromPreviewRequest,
  CreateImportResult,
} from "../../shared/importTypes";
import {
  createImportFromPreviewUnlocked,
  previewFolder,
  previewImages,
  previewZip,
  previewZipFolder,
} from "../libraryStore/importWorkflow";
import { withLibraryMutation } from "./lock";

export { previewFolder, previewImages, previewZip, previewZipFolder };

export async function createImport(
  request: CreateImportFromPreviewRequest,
): Promise<CreateImportResult> {
  return withLibraryMutation(() => createImportFromPreviewUnlocked(request));
}
