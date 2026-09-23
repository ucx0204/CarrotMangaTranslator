import type { MangaPage } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import {
  findChapterLocation,
  readChapterFile,
  readWorkFile,
} from "./libraryFiles";
import { nextChapterUpdatedAt, resolveChapterStatus } from "./chapterRecords";
import { runLibraryTransaction } from "./libraryTransaction";
import {
  stageChapterFile,
  stageWorkFile,
  stageStoryMemoryFile,
  stageStyleGuideFile,
} from "./libraryTransactionFiles";
import type { PageWorkflowContextCommit } from "../application/pageWorkflowContextCommit";

/** Commit the content and its execution receipt together; never mark OCR as translated. */
export async function savePageWorkflowResultUnlocked(
  chapterId: string,
  before: MangaPage,
  after: MangaPage,
  context: PageWorkflowContextCommit = {},
): Promise<void> {
  const location = await findChapterLocation(chapterId);
  if (!location) throw new Error("작업 대상 화를 찾지 못했습니다.");
  const chapter = await readChapterFile(location.workId, chapterId);
  const work = await readWorkFile(location.workId);
  const current = chapter?.pages.find((page) => page.id === before.id);
  if (!chapter || !work || !current)
    throw new Error("작업 대상 페이지를 찾지 못했습니다.");
  if (
    createPageRevision(current) !== createPageRevision(before) ||
    current.updatedAt !== before.updatedAt
  )
    throw new Error(
      "페이지가 변경되어 작업 결과를 저장하지 않았습니다. 다시 실행하세요.",
    );
  const { dataUrl: _dataUrl, ...record } = after;
  const now = nextChapterUpdatedAt(chapter);
  chapter.pages = chapter.pages.map((page) =>
    page.id === before.id ? { ...record, updatedAt: now } : page,
  );
  chapter.updatedAt = now;
  chapter.status = resolveChapterStatus(chapter.pages);
  await runLibraryTransaction("page-workflow-stage", async (transaction) => {
    if (context.storyMemory) {
      if (
        context.storyMemory.chapterId !== chapterId ||
        context.storyMemory.workId !== work.id
      )
        throw new Error("페이지 기억의 저장 대상이 다릅니다.");
      await stageStoryMemoryFile(transaction, context.storyMemory);
    }
    if (context.styleGuide) {
      if (context.styleGuide.workId !== work.id)
        throw new Error("용어집의 저장 대상이 다릅니다.");
      await stageStyleGuideFile(transaction, context.styleGuide);
    }
    await stageChapterFile(transaction, chapter);
    await stageWorkFile(transaction, { ...work, updatedAt: now });
  });
}
