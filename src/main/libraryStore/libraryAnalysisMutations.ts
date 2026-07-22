import { hydrateChapter } from "./chapterSnapshots";
import type { TargetBlockOperation } from "../../shared/analysisTypes";
import { resolveChapterStatus } from "./chapterRecords";
import {
  findChapterLocation,
  readChapterFile,
  touchWork,
  writeChapterFile,
  type ChapterFile,
} from "./libraryFiles";

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
  const pages = chapter.pages.map((candidate) =>
    candidate.id === pageId
      ? {
          ...candidate,
          blocks: [...candidate.blocks, ...blocks],
          analysisStatus: "completed" as const,
          lastError: undefined,
          updatedAt: now,
        }
      : candidate,
  );
  const nextChapter: ChapterFile = {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt: now,
  };
  await writeChapterFile(nextChapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(nextChapter);
}

export async function replaceAnalyzedPageBlockTextUnlocked(
  chapterId: string,
  pageId: string,
  blockId: string,
  analyzedBlock: PageBlocks[number],
  operation?: TargetBlockOperation,
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
  if (!page.blocks.some((block) => block.id === blockId)) {
    throw new Error("OCR·번역할 블록을 찾지 못했습니다.");
  }

  const now = new Date().toISOString();
  const pages = chapter.pages.map((candidate) =>
    candidate.id === pageId
      ? {
          ...candidate,
          blocks: candidate.blocks.map((block) =>
            block.id === blockId
              ? {
                  ...block,
                  sourceText:
                    operation === "translate"
                      ? block.sourceText
                      : analyzedBlock.sourceText,
                  translatedText:
                    operation === "ocr"
                      ? block.translatedText
                      : analyzedBlock.translatedText,
                  confidence:
                    operation === "translate"
                      ? block.confidence
                      : analyzedBlock.confidence,
                  sourceDirection:
                    operation === "translate"
                      ? block.sourceDirection
                      : analyzedBlock.sourceDirection,
                  reviewStatus: "draft" as const,
                }
              : block,
          ),
          analysisStatus: "completed" as const,
          lastError: undefined,
          updatedAt: now,
        }
      : candidate,
  );
  const nextChapter: ChapterFile = {
    ...chapter,
    pages,
    status: resolveChapterStatus(pages),
    updatedAt: now,
  };
  await writeChapterFile(nextChapter);
  await touchWork(locator.workId, now);
  return hydrateChapter(nextChapter);
}
