import type { ChapterSnapshot } from "../../shared/libraryTypes";
import type {
  ImportReviewTextRequest,
  ImportReviewTextResult,
} from "../../shared/reviewTypes";
import type { TranslationBlock } from "../../shared/textTypes";
import { parseReviewTable } from "../../shared/reviewTable";
import { tMain } from "./localization";
import { planReviewImport } from "../../shared/reviewImportPlan";
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

export async function applyReviewImportUnlocked(
  request: ImportReviewTextRequest,
): Promise<ImportReviewTextResult> {
  const locator = await findChapterLocation(request.chapterId);
  if (!locator) {
    throw new Error(tMain("reviewImport.chapterNotFound"));
  }
  const chapter = await readChapterFile(locator.workId, locator.chapterId);
  if (!chapter) {
    throw new Error(tMain("reviewImport.chapterNotFound"));
  }

  const rows = parseReviewTable(request.content, request.format);
  const plan = planReviewImport(chapter, rows, request);
  const changedBlocksByPage = new Map<string, Map<string, TranslationBlock>>();
  for (const row of plan.rows) {
    if (row.result !== "updated" || !row.pageId || !row.after) continue;
    const changes =
      changedBlocksByPage.get(row.pageId) ??
      new Map<string, TranslationBlock>();
    changes.set(row.blockId, row.after);
    changedBlocksByPage.set(row.pageId, changes);
  }
  const warnings = plan.diagnostics.map(({ key, values }) =>
    tMain(key, values),
  );

  const saved = await saveChangedReviewPages({
    changedBlocksByPage,
    chapter,
  });
  return {
    chapter: saved,
    updatedBlockCount: plan.updatedBlockCount,
    skippedRowCount: plan.skippedRowCount,
    warnings,
  };
}

async function saveChangedReviewPages({
  changedBlocksByPage,
  chapter,
}: {
  changedBlocksByPage: Map<string, Map<string, TranslationBlock>>;
  chapter: ChapterFile;
}): Promise<ChapterSnapshot> {
  if (changedBlocksByPage.size === 0) {
    return hydrateChapter(chapter);
  }
  const now = new Date().toISOString();
  const pages = chapter.pages.map((page) => {
    const changes = changedBlocksByPage.get(page.id);
    if (!changes) return page;
    // The shared planner rejects duplicate scoped rows. Publish the final
    // blocks and invalidate completion once per changed page.
    const blocks = page.blocks.map((block) => changes.get(block.id) ?? block);
    return {
      ...page,
      blocks,
      translationCompletion: resolveCompletionAfterBlockMutation(
        page.translationCompletion,
        page.blocks,
        blocks,
      ),
      updatedAt: now,
    };
  });
  const nextChapter: ChapterFile = {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt: now,
  };
  const work = await readWorkFile(nextChapter.workId);
  if (!work) {
    throw new Error("작품을 찾지 못했습니다.");
  }
  await runLibraryTransaction("review-import", async (transaction) => {
    await stageChapterFile(transaction, nextChapter);
    await stageWorkFile(transaction, { ...work, updatedAt: now });
  });
  return hydrateChapter(nextChapter);
}
