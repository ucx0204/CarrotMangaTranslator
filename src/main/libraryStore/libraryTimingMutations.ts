import type { PageProcessingTimingV2 } from "../../shared/pageProcessingTiming";
import type { LibraryChapter } from "../../shared/libraryTypes";
import {
  findChapterLocation,
  readChapterFile,
  readWorkFile,
} from "./libraryFiles";
import { runLibraryTransaction } from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";

export type PageProcessingTimingUpdate = Readonly<{
  pageId: string;
  timing: PageProcessingTimingV2;
  startSession?: boolean;
  replacesSessionId?: string;
}>;

export type PageProcessingTimingMutationRuntime = {
  findChapterLocation: typeof findChapterLocation;
  now: () => string;
  readChapterFile: typeof readChapterFile;
  commitChapterAndWork: (
    chapter: LibraryChapter,
    updatedAt: string,
  ) => Promise<boolean>;
};

const productionRuntime: PageProcessingTimingMutationRuntime = {
  findChapterLocation,
  now: () => new Date().toISOString(),
  readChapterFile,
  commitChapterAndWork: async (chapter, updatedAt) => {
    const work = await readWorkFile(chapter.workId);
    if (!work) return false;
    await runLibraryTransaction(
      "update-page-processing-timings",
      async (transaction) => {
        await stageChapterFile(transaction, chapter);
        await stageWorkFile(transaction, { ...work, updatedAt });
      },
    );
    return true;
  },
};

export function createUpdatePageProcessingTimingsMutation(
  runtime: PageProcessingTimingMutationRuntime,
): (
  chapterId: string,
  updates: readonly PageProcessingTimingUpdate[],
) => Promise<Set<string>> {
  return async (chapterId, updates) => {
    const changedPageIds = new Set<string>();
    if (updates.length === 0) return changedPageIds;
    const locator = await runtime.findChapterLocation(chapterId);
    if (!locator) return changedPageIds;
    const chapter = await runtime.readChapterFile(
      locator.workId,
      locator.chapterId,
    );
    if (!chapter) return changedPageIds;
    const updatesByPageId = new Map(
      updates.map((update) => [update.pageId, update]),
    );
    chapter.pages = chapter.pages.map((page) => {
      const update = updatesByPageId.get(page.id);
      if (!update || !canApplyPageTimingUpdate(page.processingTiming, update)) {
        return page;
      }
      changedPageIds.add(page.id);
      return { ...page, processingTiming: update.timing };
    });
    if (changedPageIds.size === 0) return changedPageIds;
    const now = runtime.now();
    chapter.updatedAt = now;
    if (!(await runtime.commitChapterAndWork(chapter, now))) return new Set();
    return changedPageIds;
  };
}

export const updatePageProcessingTimingsUnlocked =
  createUpdatePageProcessingTimingsMutation(productionRuntime);

export function canApplyPageTimingUpdate(
  current: PageProcessingTimingV2 | { version: 1 } | undefined,
  update: PageProcessingTimingUpdate,
): boolean {
  if (update.startSession) {
    if (!current || current.version !== 2) {
      return update.replacesSessionId === undefined;
    }
    if (current.sessionId === update.timing.sessionId) {
      return current.checkpoint <= update.timing.checkpoint;
    }
    return current.sessionId === update.replacesSessionId;
  }
  if (!current || current.version !== 2) return false;
  return (
    current.sessionId === update.timing.sessionId &&
    current.checkpoint <= update.timing.checkpoint
  );
}
