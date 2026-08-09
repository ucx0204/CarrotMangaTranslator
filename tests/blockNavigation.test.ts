import { describe, expect, it } from "vitest";
import type { TranslationBlock } from "../src/shared/textTypes";
import { sortBlocksForReading } from "../src/shared/blockReadingOrder";
import { resolveAdjacentBlockId } from "../src/renderer/src/lib/blockNavigation";
import { gatherText } from "../src/renderer/src/lib/gatherText";
import { buildReviewRows } from "../src/shared/reviewTable";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

describe("shared block reading order", () => {
  const blocks = [
    makeBlock("left", 100, 100),
    makeBlock("lower", 500, 450),
    makeBlock("right", 600, 110),
  ];

  it("groups rows top-to-bottom and flips only the horizontal direction", () => {
    expect(
      sortBlocksForReading(blocks, "rtl").map((block) => block.id),
    ).toEqual(["right", "left", "lower"]);
    expect(
      sortBlocksForReading(blocks, "ltr").map((block) => block.id),
    ).toEqual(["left", "right", "lower"]);
    expect(blocks.map((block) => block.id)).toEqual(["left", "lower", "right"]);
  });

  it("uses the same order for gathered text and review import/export rows", () => {
    const page = makePage(blocks);
    const chapter = makeChapter(page);
    expect(
      gatherText({
        chapter,
        page,
        scope: "page",
        direction: "rtl",
      })[0]?.blocks.map((block) => block.id),
    ).toEqual(["right", "left", "lower"]);
    expect(buildReviewRows(chapter, "rtl").map((row) => row.block_id)).toEqual([
      "right",
      "left",
      "lower",
    ]);
  });
});

describe("block navigation boundaries", () => {
  const blocks = [
    makeBlock("left", 100, 100),
    makeBlock("lower", 500, 450),
    makeBlock("right", 600, 110),
  ];

  it("starts at the appropriate edge when no block is selected", () => {
    expect(resolveAdjacentBlockId(blocks, null, "next", "rtl")).toBe("right");
    expect(resolveAdjacentBlockId(blocks, null, "previous", "rtl")).toBe(
      "lower",
    );
  });

  it("moves in reading order without wrapping or crossing pages", () => {
    expect(resolveAdjacentBlockId(blocks, "right", "next", "rtl")).toBe("left");
    expect(resolveAdjacentBlockId(blocks, "left", "previous", "rtl")).toBe(
      "right",
    );
    expect(
      resolveAdjacentBlockId(blocks, "right", "previous", "rtl"),
    ).toBeNull();
    expect(resolveAdjacentBlockId(blocks, "lower", "next", "rtl")).toBeNull();
  });

  it("honors left-to-right source languages", () => {
    expect(resolveAdjacentBlockId(blocks, "left", "next", "ltr")).toBe("right");
  });
});

function makeBlock(id: string, x: number, y: number): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x, y, w: 220, h: 120 },
    sourceText: `source-${id}`,
    translatedText: `translated-${id}`,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function makePage(blocks: TranslationBlock[]): MangaPage {
  return {
    id: "page-1",
    name: "page-1.png",
    imagePath: "page-1.png",
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks,
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
