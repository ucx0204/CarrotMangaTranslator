import { throwIfAborted } from "../abortSignal";
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
import {
  productionImportImageRuntime,
  type ImportImageRuntime,
} from "../libraryStore/importImageRuntime";
import { withLibraryMutation } from "./lock";

export { previewFolder, previewImages, previewZip, previewZipFolder };

export type LibraryImportRuntime = {
  image: ImportImageRuntime;
  runMutation: typeof withLibraryMutation;
};

export type LibraryImportService = {
  createImport: (
    request: CreateImportFromPreviewRequest,
    signal?: AbortSignal,
  ) => Promise<CreateImportResult>;
  previewFolder: typeof previewFolder;
  previewImages: typeof previewImages;
  previewZip: typeof previewZip;
  previewZipFolder: typeof previewZipFolder;
};

const productionLibraryImportRuntime: LibraryImportRuntime = {
  image: productionImportImageRuntime,
  runMutation: withLibraryMutation,
};

export function createLibraryImportService(
  runtime: LibraryImportRuntime,
): LibraryImportService {
  return {
    createImport: (request, signal) =>
      runtime.runMutation(() => {
        throwIfAborted(signal);
        return createImportFromPreviewUnlocked(request, runtime.image, signal);
      }),
    previewFolder,
    previewImages,
    previewZip,
    previewZipFolder,
  };
}

export const { createImport } = createLibraryImportService(
  productionLibraryImportRuntime,
);
