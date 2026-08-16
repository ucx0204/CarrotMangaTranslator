import { describe, expect, it } from "vitest";
import { collectPageBlockUpdates } from "../src/renderer/src/hooks/chapterPersistencePayload";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

describe("chapter persistence payload", () => {
  it("preserves a visible off-page render box and never moves the source bbox", () => {
    const chapter = makeChapter();
    const update = collectPageBlockUpdates(
      chapter,
      [chapter.pages[0].id],
      new Map(),
    )[0];

    expect(update?.blocks[0]?.bbox).toEqual({ x: 40, y: 120, w: 160, h: 180 });
    expect(update?.blocks[0]?.renderBbox).toEqual({
      x: -152,
      y: 120,
      w: 160,
      h: 180,
    });
  });

  it("recovers an invisible render box before saving", () => {
    const chapter = makeChapter();
    chapter.pages[0].blocks[0].renderBbox = {
      x: -2_000,
      y: 120,
      w: 160,
      h: 180,
    };
    const update = collectPageBlockUpdates(
      chapter,
      [chapter.pages[0].id],
      new Map(),
    )[0];

    expect(update?.blocks[0]?.bbox).toEqual({ x: 40, y: 120, w: 160, h: 180 });
    expect(update?.blocks[0]?.renderBbox?.x).toBe(-152);
  });

  it("normalizes legacy pixel-space render boxes before saving", () => {
    const chapter = makeChapter();
    chapter.pages[0].height = 2_000;
    chapter.pages[0].blocks[0].renderBbox = {
      x: -100,
      y: 200,
      w: 400,
      h: 600,
    };
    chapter.pages[0].blocks[0].renderBboxSpace = "pixels";
    const update = collectPageBlockUpdates(
      chapter,
      [chapter.pages[0].id],
      new Map(),
    )[0];

    expect(update?.blocks[0]?.renderBbox).toEqual({
      x: -100,
      y: 100,
      w: 400,
      h: 300,
    });
    expect(update?.blocks[0]?.renderBboxSpace).toBe("normalized_1000");
  });

  it("normalizes a legacy pixel-space source box before saving", () => {
    const chapter = makeChapter();
    chapter.pages[0].width = 2_000;
    chapter.pages[0].height = 1_000;
    chapter.pages[0].blocks[0].bbox = {
      x: 1_000,
      y: 250,
      w: 400,
      h: 200,
    };
    chapter.pages[0].blocks[0].bboxSpace = "pixels";
    const update = collectPageBlockUpdates(
      chapter,
      [chapter.pages[0].id],
      new Map(),
    )[0];

    expect(update?.blocks[0]?.bbox).toEqual({
      x: 500,
      y: 250,
      w: 200,
      h: 200,
    });
    expect(update?.blocks[0]?.bboxSpace).toBe("normalized_1000");
  });
});

function makeChapter(): ChapterSnapshot {
  const now = "2026-08-15T00:00:00.000Z";
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "시험",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page-1"],
    pages: [
      {
        id: "page-1",
        name: "page.png",
        imagePath: "page.png",
        dataUrl: "",
        width: 1000,
        height: 1000,
        analysisStatus: "completed",
        createdAt: now,
        updatedAt: now,
        blocks: [
          {
            id: "block-1",
            type: "nonsolid",
            bbox: { x: 40, y: 120, w: 160, h: 180 },
            renderBbox: { x: -152, y: 120, w: 160, h: 180 },
            renderBboxSpace: "normalized_1000",
            sourceText: "原文",
            translatedText: "번역",
            confidence: 1,
            sourceDirection: "horizontal",
            renderDirection: "horizontal",
            fontSizePx: 48,
            lineHeight: 1.18,
            textAlign: "center",
            textColor: "#111111",
            backgroundColor: "#ffffff",
            opacity: 1,
          },
        ],
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}
