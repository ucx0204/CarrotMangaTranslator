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
import {
  prepareArchiveFolderImportPreview,
  prepareArchiveImportPreview,
  preparePdfImportPreview,
} from "../libraryStore/importPreparedPreview";
import type { ImportSourceProgress as ImportSourceRunnerProgress } from "../libraryStore/importSourceRunner";
import { withLibraryContentEdit, withLibraryMutation } from "./lock";
import { libraryStructureResource } from "../../shared/appActivityTypes";
import { libraryMutationCoordinator } from "../libraryStore/libraryMutationCoordinator";

export {
  prepareArchiveFolderImportPreview,
  prepareArchiveImportPreview,
  preparePdfImportPreview,
  previewFolder,
  previewImages,
  previewZip,
  previewZipFolder,
};
export type LibraryImportRuntime = {
  image: ImportImageRuntime;
  runMutation: typeof withLibraryMutation;
};

export type ImportSourceProgress = ImportSourceRunnerProgress;

export type LibraryImportService = {
  createImport: (
    request: CreateImportFromPreviewRequest,
    signal?: AbortSignal,
    publication?: Parameters<typeof createImportFromPreviewUnlocked>[4],
  ) => Promise<CreateImportResult>;
  previewFolder: typeof previewFolder;
  previewImages: typeof previewImages;
  previewZip: typeof previewZip;
  previewZipFolder: typeof previewZipFolder;
  prepareArchiveFolderImportPreview: typeof prepareArchiveFolderImportPreview;
  prepareArchiveImportPreview: typeof prepareArchiveImportPreview;
  preparePdfImportPreview: typeof preparePdfImportPreview;
};

const productionLibraryImportRuntime: LibraryImportRuntime = {
  image: productionImportImageRuntime,
  runMutation: withLibraryMutation,
};

export function createLibraryImportService(
  runtime: LibraryImportRuntime,
): LibraryImportService {
  return {
    createImport: async (request, signal, publication) => {
      const pending = libraryMutationCoordinator.begin();
      try {
        return await createImportFromPreviewUnlocked(
          request,
          runtime.image,
          signal,
          (publish) =>
            withLibraryContentEdit(
              request.target.mode === "existing"
                ? [libraryStructureResource("work", request.target.workId)]
                : [],
              () =>
                runtime.runMutation(() => {
                  throwIfAborted(signal);
                  return publish();
                }),
              signal ?? new AbortController().signal,
            ),
          publication,
        );
      } finally {
        pending.finish();
      }
    },
    previewFolder,
    previewImages,
    previewZip,
    previewZipFolder,
    prepareArchiveFolderImportPreview,
    prepareArchiveImportPreview,
    preparePdfImportPreview,
  };
}

export const { createImport } = createLibraryImportService(
  productionLibraryImportRuntime,
);
