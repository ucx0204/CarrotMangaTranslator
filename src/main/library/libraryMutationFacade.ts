import { savePageWorkflowResultUnlocked } from "../libraryStore/pageWorkflowMutations";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../../shared/libraryTypes";
import type { PageRevision } from "../../shared/pageRevisionTypes";
import type {
  SavePageBlocksRequest,
  SavePagesBlocksRequest,
} from "../../shared/shareTypes";
import {
  cleanupLibraryOrphansUnlocked,
  type LibraryCleanupResult,
} from "../libraryStore/libraryCleanup";
import {
  deleteChapterUnlocked,
  deletePageUnlocked,
  deleteWorkUnlocked,
  finalizeRunningPagesUnlocked,
  markChapterPagesRunningUnlocked,
  renameChapterUnlocked,
  renameWorkUnlocked,
  reorderChaptersUnlocked,
  reorderPagesUnlocked,
  updatePageAfterAnalysisUnlocked,
  updatePagesAfterAnalysisUnlocked,
  type PageAnalysisUpdate,
} from "../libraryStore/libraryMutations";
import {
  savePageBlocksUnlocked,
  savePagesBlocksUnlocked,
} from "../libraryStore/libraryPageBlockMutations";
import { appendAnalyzedPageBlocksUnlocked } from "../libraryStore/libraryAnalysisMutations";
import {
  setPageInpaintingResultUnlocked,
  updatePagesAfterInpaintingUnlocked,
  type InpaintingArtifactCleanupOptions,
} from "../libraryStore/libraryInpaintingMutations";
import { assertLibraryActivityAccess, withLibraryMutation } from "./lock";
import {
  pageContentResource,
  libraryStructureResource,
  type AppActivityResource,
} from "../../shared/appActivityTypes";
import { notifyLinkedWorkspacePagesSaved } from "../linkedWorkspace/linkedWorkspaceNotifications";
import {
  updatePageProcessingTimingsUnlocked,
  type PageProcessingTimingUpdate,
} from "../libraryStore/libraryTimingMutations";
import { saveTranslationCheckpointUnlocked } from "../libraryStore/translationCheckpointStore";
import type { PreparedTranslationCheckpoint } from "../pipeline/preparedTranslationCheckpointContract";
import { readWorkFile } from "../libraryStore/libraryFiles";

export type SavePageBlocksRuntime = {
  runMutation: typeof withLibraryMutation;
  savePageBlocks: typeof savePageBlocksUnlocked;
};

const productionSavePageBlocksRuntime: SavePageBlocksRuntime = {
  runMutation: withLibraryMutation,
  savePageBlocks: savePageBlocksUnlocked,
};

function guardedMutation<T>(
  resources: AppActivityResource[],
  operation: () => Promise<T>,
): Promise<T> {
  return withLibraryMutation(() => {
    assertLibraryActivityAccess(resources);
    return operation();
  });
}

export function createSavePageBlocks(runtime: SavePageBlocksRuntime) {
  return async (request: SavePageBlocksRequest): Promise<ChapterSnapshot> => {
    const chapter = await runtime.runMutation(() => {
      assertLibraryActivityAccess([
        pageContentResource(request.chapterId, request.pageId),
      ]);
      return runtime.savePageBlocks(request);
    });
    notifyLinkedWorkspacePagesSaved(request.chapterId, [request.pageId]);
    return chapter;
  };
}

export const savePageBlocks = createSavePageBlocks(
  productionSavePageBlocksRuntime,
);

export type SavePagesBlocksRuntime = {
  runMutation: typeof withLibraryMutation;
  savePagesBlocks: typeof savePagesBlocksUnlocked;
};

const productionSavePagesBlocksRuntime: SavePagesBlocksRuntime = {
  runMutation: withLibraryMutation,
  savePagesBlocks: savePagesBlocksUnlocked,
};

export function createSavePagesBlocks(runtime: SavePagesBlocksRuntime) {
  return async (request: SavePagesBlocksRequest): Promise<ChapterSnapshot> => {
    const chapter = await runtime.runMutation(() => {
      assertLibraryActivityAccess(
        request.pages.map((page) =>
          pageContentResource(request.chapterId, page.pageId),
        ),
      );
      return runtime.savePagesBlocks(request);
    });
    notifyLinkedWorkspacePagesSaved(
      request.chapterId,
      request.pages.map((page) => page.pageId),
    );
    return chapter;
  };
}

export const savePagesBlocks = createSavePagesBlocks(
  productionSavePagesBlocksRuntime,
);

export async function savePageWorkflowResult(
  chapterId: string,
  before: MangaPage,
  after: MangaPage,
  context?: import("../application/pageWorkflowContextCommit").PageWorkflowContextCommit,
): Promise<void> {
  await guardedMutation([pageContentResource(chapterId, before.id)], () =>
    savePageWorkflowResultUnlocked(chapterId, before, after, context),
  );
  notifyLinkedWorkspacePagesSaved(chapterId, [before.id]);
}

export async function appendAnalyzedPageBlocks(
  chapterId: string,
  pageId: string,
  blocks: MangaPage["blocks"],
  options?: Parameters<typeof appendAnalyzedPageBlocksUnlocked>[3],
): Promise<ChapterSnapshot> {
  const chapter = await guardedMutation(
    [pageContentResource(chapterId, pageId)],
    () => appendAnalyzedPageBlocksUnlocked(chapterId, pageId, blocks, options),
  );
  notifyLinkedWorkspacePagesSaved(chapterId, [pageId]);
  return chapter;
}

export async function renameWork(
  workId: string,
  title: string,
): Promise<LibraryIndex> {
  return withLibraryMutation(() => renameWorkUnlocked(workId, title));
}

export async function renameChapter(
  chapterId: string,
  title: string,
): Promise<LibraryIndex> {
  return withLibraryMutation(() => renameChapterUnlocked(chapterId, title));
}

export async function deleteWork(workId: string): Promise<LibraryIndex> {
  return guardedMutation(
    [libraryStructureResource("work", workId)],
    async () => {
      const work = await readWorkFile(workId);
      assertLibraryActivityAccess(
        (work?.chapterOrder ?? []).flatMap((id) => [
          libraryStructureResource("chapter", id),
          pageContentResource(id, "**"),
        ]),
      );
      return deleteWorkUnlocked(workId);
    },
  );
}

export async function deleteChapter(chapterId: string): Promise<LibraryIndex> {
  return guardedMutation(
    [
      libraryStructureResource("chapter", chapterId),
      pageContentResource(chapterId, "**"),
    ],
    () => deleteChapterUnlocked(chapterId),
  );
}

export async function reorderChapters(
  workId: string,
  chapterIds: string[],
): Promise<LibraryIndex> {
  return guardedMutation([libraryStructureResource("work", workId)], () =>
    reorderChaptersUnlocked(workId, chapterIds),
  );
}

export async function reorderPages(
  chapterId: string,
  pageIds: string[],
): Promise<ChapterSnapshot> {
  return guardedMutation([libraryStructureResource("chapter", chapterId)], () =>
    reorderPagesUnlocked(chapterId, pageIds),
  );
}

export async function deletePage(
  chapterId: string,
  pageId: string,
): Promise<ChapterSnapshot> {
  return guardedMutation(
    [
      libraryStructureResource("page", `${chapterId}/${pageId}`),
      pageContentResource(chapterId, pageId),
    ],
    () => deletePageUnlocked(chapterId, pageId),
  );
}

export async function markChapterPagesRunning(
  chapterId: string,
  pageIds: string[],
): Promise<ChapterSnapshot> {
  return withLibraryMutation(() =>
    markChapterPagesRunningUnlocked(chapterId, pageIds),
  );
}

export async function updatePageAfterAnalysis(
  chapterId: string,
  page: MangaPage,
  warnings: string[],
  status: "completed" | "failed",
  expectedUpdatedAt?: string,
  expectedRevision?: PageRevision,
): Promise<boolean> {
  const updated = await guardedMutation(
    [pageContentResource(chapterId, page.id)],
    () =>
      updatePageAfterAnalysisUnlocked(
        chapterId,
        page,
        warnings,
        status,
        expectedUpdatedAt,
        expectedRevision,
      ),
  );
  if (updated) notifyLinkedWorkspacePagesSaved(chapterId, [page.id]);
  return updated;
}

export async function updatePagesAfterAnalysis(
  chapterId: string,
  updates: PageAnalysisUpdate[],
): Promise<ReadonlySet<string>> {
  const changed = await guardedMutation(
    updates.map(({ page }) => pageContentResource(chapterId, page.id)),
    () => updatePagesAfterAnalysisUnlocked(chapterId, updates),
  );
  notifyLinkedWorkspacePagesSaved(chapterId, [...changed]);
  return changed;
}

export async function finalizeRunningPages(
  chapterId: string,
  pageIds: string[],
  status: "idle" | "failed",
  errorMessage?: string,
): Promise<void> {
  return withLibraryMutation(() =>
    finalizeRunningPagesUnlocked(chapterId, pageIds, status, errorMessage),
  );
}

export async function updatePageProcessingTimings(
  chapterId: string,
  updates: readonly PageProcessingTimingUpdate[],
): Promise<ReadonlySet<string>> {
  return withLibraryMutation(() =>
    updatePageProcessingTimingsUnlocked(chapterId, updates),
  );
}

export async function updatePagesAfterInpainting(
  chapterId: string,
  pages: MangaPage[],
  cleanupOptions?: InpaintingArtifactCleanupOptions,
): Promise<ChapterSnapshot> {
  const chapter = await guardedMutation(
    pages.map((page) => pageContentResource(chapterId, page.id)),
    () => updatePagesAfterInpaintingUnlocked(chapterId, pages, cleanupOptions),
  );
  notifyLinkedWorkspacePagesSaved(
    chapterId,
    pages.map((page) => page.id),
  );
  return chapter;
}

export async function setPageInpaintingResult(
  chapterId: string,
  pageId: string,
  inpaintedImagePath?: string | null,
  cleanupOptions?: InpaintingArtifactCleanupOptions,
): Promise<ChapterSnapshot> {
  const chapter = await guardedMutation(
    [pageContentResource(chapterId, pageId)],
    () =>
      setPageInpaintingResultUnlocked(
        chapterId,
        pageId,
        inpaintedImagePath,
        cleanupOptions,
      ),
  );
  notifyLinkedWorkspacePagesSaved(chapterId, [pageId]);
  return chapter;
}

export async function cleanupLibraryOrphans(): Promise<LibraryCleanupResult> {
  return guardedMutation(
    [{ kind: "library-structure", scope: "*", access: "write" }],
    cleanupLibraryOrphansUnlocked,
  );
}

export async function saveTranslationCheckpoint(
  chapterId: string,
  checkpoint: PreparedTranslationCheckpoint,
  expectedRevision: PageRevision,
): Promise<boolean> {
  return guardedMutation(
    [pageContentResource(chapterId, checkpoint.pageId)],
    () =>
      saveTranslationCheckpointUnlocked({
        chapterId,
        checkpoint,
        expectedRevision,
      }),
  );
}
