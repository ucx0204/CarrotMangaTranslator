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
import {
  captureWorkShareSnapshot,
  exportWorkShareToFile as exportWorkShareToFileUnlocked,
} from "../libraryStore/shareExportWorkflow";
import {
  withLibraryContentEdit,
  withLibraryMutation,
  withLibraryRead,
} from "./lock";
import {
  libraryStructureResource,
  pageContentResource,
} from "../../shared/appActivityTypes";
import { ensureExistingWork } from "../libraryStore/libraryFiles";
import { libraryMutationCoordinator } from "../libraryStore/libraryMutationCoordinator";
import { retainLibrarySnapshot } from "./lock";

export { previewWorkShareImport };

export type WorkShareExportRuntime = {
  capture?: typeof captureWorkShareSnapshot;
  exportWorkShare: typeof exportWorkShareToFileUnlocked;
  runRead: typeof withLibraryRead;
};

const productionWorkShareExportRuntime: WorkShareExportRuntime = {
  capture: captureWorkShareSnapshot,
  exportWorkShare: exportWorkShareToFileUnlocked,
  runRead: withLibraryRead,
};

export function createWorkShareExport(runtime: WorkShareExportRuntime) {
  return async (
    request: WorkShareExportRequest & { outputPath: string },
    signal?: AbortSignal,
  ): Promise<WorkShareExportResult> => {
    const capture = runtime.capture;
    if (!capture)
      return runtime.runRead(() => {
        throwIfAborted(signal);
        return runtime.exportWorkShare(request, signal);
      });
    const snapshot = await runtime.runRead(async () => {
      const value = await capture(request, signal);
      return {
        ...value,
        release: retainLibrarySnapshot(value.resources, value.paths),
      };
    });
    try {
      return await runtime.exportWorkShare(request, signal, snapshot.readers);
    } finally {
      snapshot.release();
    }
  };
}

export const exportWorkShareToFile = createWorkShareExport(
  productionWorkShareExportRuntime,
);

export async function importWorkShare(
  request: WorkShareImportFromPackageRequest,
  signal?: AbortSignal,
): Promise<WorkShareImportResult> {
  const pending = libraryMutationCoordinator.begin();
  try {
    return await importWorkShareUnlocked(
      request,
      signal,
      undefined,
      (publish) =>
        withLibraryContentEdit(
          request.target.mode === "existing"
            ? [libraryStructureResource("work", request.target.workId)]
            : [],
          async () => {
            const removed = [];
            if (request.target.mode === "existing") {
              const work = await ensureExistingWork(request.target.workId);
              const kept = new Set(
                request.entries.flatMap((entry) =>
                  entry.source === "existing" ? [entry.chapterId] : [],
                ),
              );
              removed.push(
                ...work.chapterOrder
                  .filter((id) => !kept.has(id))
                  .flatMap((id) => [
                    libraryStructureResource("chapter", id),
                    pageContentResource(id, "**"),
                  ]),
              );
            }
            return withLibraryContentEdit(
              removed,
              () =>
                withLibraryMutation(() => {
                  throwIfAborted(signal);
                  return publish();
                }),
              signal ?? new AbortController().signal,
            );
          },
          signal ?? new AbortController().signal,
        ),
    );
  } finally {
    pending.finish();
  }
}
