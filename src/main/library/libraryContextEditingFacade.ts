import type {
  WorkStyleGuide,
  ChapterStoryMemory,
} from "../../shared/workContextTypes";
import { openChapter } from "../libraryStore/libraryAccess";
import {
  readChapterStoryMemory,
  resolveWorkContextForChapter,
} from "../libraryStore/workContextFiles";
import { runLibraryTransaction } from "../libraryStore/libraryTransaction";
import {
  stageStoryMemoryFile,
  stageStyleGuideFile,
} from "../libraryStore/libraryTransactionFiles";
import {
  assertLibraryActivityAccess,
  withLibraryMutation,
  withLibraryRead,
} from "./lock";

/** Unlike the display projection, editing retains unrelated/orphaned memory rows. */
/** Native transaction callers must already hold the library read/write boundary. */
export async function readWorkContextEditSnapshotUnlocked(chapterId: string) {
  const context = await resolveWorkContextForChapter(chapterId);
  return {
    ...context,
    storyMemory: await readChapterStoryMemory(chapterId),
    chapter: await openChapter(chapterId),
  };
}

export function readWorkContextForEdit(chapterId: string) {
  return withLibraryRead(() => readWorkContextEditSnapshotUnlocked(chapterId));
}

/** The caller's policy runs INSIDE the normal library write queue. Both context
 * files share the existing publication/rollback protocol, including auth recheck. */
export function commitWorkContextEdit<T>(
  chapterId: string,
  transform: (
    current: Awaited<ReturnType<typeof readWorkContextEditSnapshotUnlocked>>,
  ) => {
    styleGuide?: WorkStyleGuide;
    storyMemory?: ChapterStoryMemory;
    result: T;
  },
  assertAuthorized: () => void,
): Promise<T> {
  return withLibraryMutation(async () => {
    assertAuthorized();
    const current = await readWorkContextEditSnapshotUnlocked(chapterId);
    assertLibraryActivityAccess([
      { kind: "work-context", scope: current.workId, access: "write" },
    ]);
    assertAuthorized();
    const changed = transform(current);
    if (
      (changed.styleGuide && changed.styleGuide.workId !== current.workId) ||
      (changed.storyMemory &&
        (changed.storyMemory.workId !== current.workId ||
          changed.storyMemory.chapterId !== chapterId))
    )
      throw new Error("Context edit cannot change work or chapter identity.");
    if (changed.styleGuide || changed.storyMemory) {
      await runLibraryTransaction("edit-work-context", async (transaction) => {
        if (changed.styleGuide)
          await stageStyleGuideFile(transaction, changed.styleGuide);
        if (changed.storyMemory)
          await stageStoryMemoryFile(transaction, changed.storyMemory);
        transaction.beforePublish(async () => {
          assertAuthorized();
        });
      });
    }
    return changed.result;
  });
}
