import { describe, expect, it } from "vitest";
import { applyBubbleNaturalTextLayout } from "../src/main/inpainting/bubbleLayoutNaturalText";
import { applyFormatToChapterPages } from "../src/renderer/src/lib/blockFormatApply";
import {
  applyFormatDefaultsToBlock,
  DEFAULT_BLOCK_FORMAT_DEFAULTS,
} from "../src/shared/blockFormat";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("text layout intent user overrides", () => {
  it("clears the advisory for bulk/style direction patches but not unrelated patches", () => {
    const page = makePage(makeBlock());
    const chapter = makeChapter(page);

    const directionEdited = applyFormatToChapterPages(
      chapter,
      new Set([page.id]),
      null,
      { renderDirection: "horizontal" },
    );
    const unrelatedEdit = applyFormatToChapterPages(
      chapter,
      new Set([page.id]),
      null,
      { bold: true },
    );

    expect(directionEdited.pages[0].blocks[0]).not.toHaveProperty(
      "layoutIntent",
    );
    expect(directionEdited.pages[0].blocks[0]?.layoutIntentSuppressed).toBe(
      true,
    );
    expect(unrelatedEdit.pages[0].blocks[0]?.layoutIntent).toBe("vertical");
    expect(
      unrelatedEdit.pages[0].blocks[0]?.layoutIntentSuppressed,
    ).toBeUndefined();
  });

  it("clears the advisory for non-auto defaults and preserves it for auto defaults", () => {
    const block = makeBlock({
      bbox: { x: 20, y: 100, w: 25, h: 300 },
      translatedText: "세로쓰기",
    });
    const automatic = applyFormatDefaultsToBlock(block, {
      ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
      renderDirection: "auto",
    });
    const horizontal = applyFormatDefaultsToBlock(block, {
      ...DEFAULT_BLOCK_FORMAT_DEFAULTS,
      renderDirection: "horizontal",
    });

    expect(automatic.layoutIntent).toBe("vertical");
    expect(automatic.layoutIntentSuppressed).toBeUndefined();
    expect(horizontal.renderDirection).toBe("horizontal");
    expect(horizontal).not.toHaveProperty("layoutIntent");
    expect(horizontal.layoutIntentSuppressed).toBe(true);
    expect(
      applyBubbleNaturalTextLayout(makePage(horizontal), { locale: "ko" })
        .blocks[0]?.renderDirection,
    ).toBe("horizontal");
  });
});

function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: "chapter-layout-intent",
    workId: "work-layout-intent",
    title: "Layout intent",
    sourceKind: "images",
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function makePage(block: TranslationBlock): MangaPage {
  return {
    id: "page-layout-intent",
    name: "001.png",
    imagePath: "001.png",
    dataUrl: "",
    width: 1000,
    height: 1500,
    blocks: [block],
    analysisStatus: "completed",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function makeBlock(patch: Partial<TranslationBlock> = {}): TranslationBlock {
  return {
    id: "block-layout-intent",
    type: "nonsolid",
    bbox: { x: 20, y: 100, w: 70, h: 600 },
    sourceText: "ページ外側の長い説明文です",
    translatedText: "페이지 바깥쪽의 긴 설명문입니다",
    textRole: "ordinary",
    confidence: 1,
    sourceDirection: "vertical",
    layoutIntent: "vertical",
    renderDirection: "horizontal",
    fontSizePx: 20,
    lineHeight: 1.18,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "transparent",
    opacity: 1,
    ...patch,
  };
}
