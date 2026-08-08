import { hydrateChapter } from "./chapterSnapshots";
import { resolveChapterStatus } from "./chapterRecords";
import {
  findChapterLocation,
  readChapterFile,
  readWorkFile,
  type ChapterFile,
} from "./libraryFiles";
import { runLibraryTransaction } from "./libraryTransaction";
import { stageChapterFile, stageWorkFile } from "./libraryTransactionFiles";
import { resolveCompletionAfterBlockMutation } from "./translationCompletionInvalidation";

type PageBlocks = ChapterFile["pages"][number]["blocks"];
type ChapterSnapshot = ReturnType<typeof hydrateChapter>;

export async function appendAnalyzedPageBlocksUnlocked(
  chapterId: string,
  pageId: string,
  blocks: PageBlocks,
): Promise<ChapterSnapshot> {
  const locator = await findChapterLocation(chapterId);
  if (!locator) {
    throw new Error("저장할 화를 찾지 못했습니다.");
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error("저장할 화를 찾지 못했습니다.");
  }
  const page = chapter.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    throw new Error("저장할 페이지를 찾지 못했습니다.");
  }

  const now = new Date().toISOString();
  const pages = chapter.pages.map((candidate) => {
    if (candidate.id !== pageId) return candidate;
    const nextBlocks = [...candidate.blocks, ...blocks];
    return {
      ...candidate,
      blocks: nextBlocks,
      analysisStatus: "completed" as const,
      translationCompletion: resolveCompletionAfterBlockMutation(
        candidate.translationCompletion,
        candidate.blocks,
        nextBlocks,
      ),
      lastError: undefined,
      updatedAt: now,
    };
  });
  const nextChapter: ChapterFile = {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt: now,
  };
  const work = await readWorkFile(locator.workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  await runLibraryTransaction(
    "append-analyzed-page-blocks",
    async (transaction) => {
      await stageChapterFile(transaction, nextChapter);
      await stageWorkFile(transaction, { ...work, updatedAt: now });
    },
  );
  return hydrateChapter(nextChapter);
}
