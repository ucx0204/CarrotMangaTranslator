import { join } from "node:path";
import { readChapterFile, readWorkFile, type WorkFile } from "./libraryFiles";
import { getWorksRoot } from "./libraryPaths";
import { stageWorkFile } from "./libraryTransactionFiles";
import type { LibraryTransaction } from "./libraryTransaction";

/** Caller holds the ordinary library boundary; no alternate catalog or deletion engine. */
export async function prepareChapterDeletionUnlocked(
  workId: string,
  chapterId: string,
) {
  const work = await readWorkFile(workId);
  if (!work) throw new Error("작품을 찾지 못했습니다.");
  if (!work.chapterOrder.includes(chapterId))
    throw new Error("화 소속이 변경됐습니다.");
  const chapter = await readChapterFile(workId, chapterId);
  if (!chapter) throw new Error("화를 찾지 못했습니다.");
  return {
    work,
    chapter,
    after: {
      ...work,
      chapterOrder: work.chapterOrder.filter((id) => id !== chapterId),
      updatedAt: new Date().toISOString(),
    },
  };
}

/** Shares the desktop's exact work-order update and transactional directory retirement.
 * Retention callers must stage their verified recovery copy in this SAME transaction. */
export async function stageChapterDeletionUnlocked(
  transaction: LibraryTransaction,
  work: WorkFile,
  chapterId: string,
) {
  if (work.chapterOrder.includes(chapterId))
    throw new Error("Deleted chapter is still in the destination work order.");
  await stageWorkFile(transaction, work);
  await transaction.retireDirectory(
    join(getWorksRoot(), work.id, "chapters", chapterId),
    { required: true },
  );
}
