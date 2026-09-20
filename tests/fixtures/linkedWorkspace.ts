import type { ChapterSnapshot, MangaPage } from "../../src/shared/libraryTypes";
import type { TranslationBlock } from "../../src/shared/textTypes";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_ID = "33333333-3333-4333-8333-333333333333";

export function makeChapter(pageCount = 1): ChapterSnapshot {
  const timestamp = "2026-08-24T00:00:00.000Z";
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const name = `${String(pageNumber).padStart(3, "0")}.png`;
    const block = {
      id: `block-${pageNumber}`,
      bbox: { x: 100, y: 100, w: 300, h: 200 },
      sourceText: "原文",
      translatedText: "번역",
      confidence: 0.9,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 24,
      lineHeight: 1.2,
      textAlign: "center",
      textColor: "#111111",
      outlineColor: "#ffffff",
      outlineWidthScale: 1,
      backgroundColor: "#ffffff",
      opacity: 1,
    } as TranslationBlock;
    return {
      id: pageNumber === 1 ? PAGE_ID : makePageId(pageNumber),
      name,
      imagePath: `C:/internal/${name}`,
      sourceFileName: name,
      sourceRelativePath: name,
      dataUrl: "",
      width: 1000,
      height: 1500,
      blocks: [block],
      blockOrder: [block.id],
      analysisStatus: "completed",
      createdAt: timestamp,
      updatedAt: timestamp,
    } satisfies MangaPage;
  });
  return {
    id: CHAPTER_ID,
    workId: WORK_ID,
    title: "1화",
    sourceKind: "folder",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makePageId(pageNumber: number): string {
  return `33333333-3333-4333-8333-${String(pageNumber).padStart(12, "0")}`;
}
