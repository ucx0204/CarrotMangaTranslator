import { describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { applyGatherTextFormatRequest } from "../src/renderer/src/app/session/applyGatherTextFormatRequest";
import type { UpdateCurrentChapter } from "../src/renderer/src/hooks/useCurrentChapterUpdater";
import { applyGatherDirectFormat } from "../src/renderer/src/lib/gatherTextFormat";
import { setupRendererI18n } from "./setupI18n";

const TS = "2026-01-01T00:00:00.000Z";

setupRendererI18n();

describe("applyGatherDirectFormat", () => {
  it("applies only touched fields across pages and preserves content", () => {
    const chapter = makeChapter([
      makePage("p1", [makeBlock("one", { fontSizePx: 18, bold: false })]),
      makePage("p2", [makeBlock("two", { fontSizePx: 26, bold: false })]),
      makePage("p3", [makeBlock("keep", { fontSizePx: 40, bold: false })]),
    ]);

    const result = applyGatherDirectFormat(
      chapter,
      {
        targets: [
          { pageId: "p1", blockId: "one" },
          { pageId: "p2", blockId: "two" },
        ],
        patch: { bold: true },
      },
      "2026-02-02T00:00:00.000Z",
    );

    expect(result.dirtyPageIds).toEqual(["p1", "p2"]);
    expect(result.chapter.pages[0].blocks[0]).toMatchObject({
      bold: true,
      fontSizePx: 18,
      translatedText: "translation-one",
      reviewNote: "keep-me",
    });
    expect(result.chapter.pages[1].blocks[0]).toMatchObject({
      bold: true,
      fontSizePx: 26,
    });
    expect(result.chapter.pages[2]).toBe(chapter.pages[2]);
  });

  it("strips non-format fields even from an untrusted runtime patch", () => {
    const chapter = makeChapter([makePage("p1", [makeBlock("one")])]);
    const patch = {
      fontSizePx: 32,
      translatedText: "do-not-copy",
      bbox: { x: 90, y: 90, w: 1, h: 1 },
    };

    const changed = applyGatherDirectFormat(chapter, {
      targets: [{ pageId: "p1", blockId: "one" }],
      patch,
    }).chapter.pages[0].blocks[0];

    expect(changed.fontSizePx).toBe(32);
    expect(changed.translatedText).toBe("translation-one");
    expect(changed.bbox).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("makes an explicit gathered size authoritative over source matching", () => {
    const chapter = makeChapter([
      makePage("p1", [
        makeBlock("one", {
          autoFitText: false,
          fontSizeIntent: "source-match",
          fontSizePx: 12,
          sourceFontFacePx: 30,
        }),
      ]),
    ]);

    const result = applyGatherDirectFormat(chapter, {
      targets: [{ pageId: "p1", blockId: "one" }],
      patch: { autoFitText: false, fontSizePx: 32 },
    });

    expect(result.chapter.pages[0].blocks[0]).toMatchObject({
      autoFitText: false,
      fontSizeIntent: "manual",
      fontSizePx: 32,
    });
  });

  it("makes an explicit gathered direction authoritative without clearing on unrelated edits", () => {
    const chapter = makeChapter([
      makePage("p1", [makeBlock("one", { layoutIntent: "vertical" })]),
    ]);

    const directionEdited = applyGatherDirectFormat(chapter, {
      targets: [{ pageId: "p1", blockId: "one" }],
      patch: { renderDirection: "horizontal" },
    });
    const unrelatedEdit = applyGatherDirectFormat(chapter, {
      targets: [{ pageId: "p1", blockId: "one" }],
      patch: { bold: true },
    });

    expect(directionEdited.dirtyPageIds).toEqual(["p1"]);
    expect(directionEdited.chapter.pages[0].blocks[0]).not.toHaveProperty(
      "layoutIntent",
    );
    expect(
      directionEdited.chapter.pages[0].blocks[0]?.layoutIntentSuppressed,
    ).toBe(true);
    expect(unrelatedEdit.chapter.pages[0].blocks[0]?.layoutIntent).toBe(
      "vertical",
    );
    expect(
      unrelatedEdit.chapter.pages[0].blocks[0]?.layoutIntentSuppressed,
    ).toBeUndefined();
  });

  it("returns the original chapter when targets or values produce no change", () => {
    const chapter = makeChapter([
      makePage("p1", [makeBlock("one", { fontSizePx: 24 })]),
    ]);

    const noTarget = applyGatherDirectFormat(chapter, {
      targets: [{ pageId: "missing", blockId: "missing" }],
      patch: { bold: true },
    });
    const noValueChange = applyGatherDirectFormat(chapter, {
      targets: [{ pageId: "p1", blockId: "one" }],
      patch: { fontSizePx: 24 },
    });

    expect(noTarget.chapter).toBe(chapter);
    expect(noTarget.dirtyPageIds).toEqual([]);
    expect(noValueChange.chapter).toBe(chapter);
    expect(noValueChange.dirtyPageIds).toEqual([]);
  });

  it("commits a multi-page direct edit in one history update", () => {
    const chapter = makeChapter([
      makePage("p1", [makeBlock("one")]),
      makePage("p2", [makeBlock("two")]),
    ]);
    const committed: ChapterSnapshot[] = [];
    const updateCurrentChapter = vi.fn(
      (...args: Parameters<UpdateCurrentChapter>) => {
        committed.push(args[1](chapter));
      },
    );

    const applied = applyGatherTextFormatRequest(
      chapter,
      {
        targets: [
          { pageId: "p1", blockId: "one" },
          { pageId: "p2", blockId: "two" },
        ],
        patch: { italic: true, textColor: "#dd8844", textOpacity: 0.6 },
      },
      updateCurrentChapter,
    );

    expect(applied).toBe(true);
    expect(updateCurrentChapter).toHaveBeenCalledOnce();
    expect(updateCurrentChapter.mock.calls[0][2]).toMatchObject({
      dirtyPageIds: ["p1", "p2"],
    });
    expect(committed[0]?.pages.map((page) => page.blocks[0]?.italic)).toEqual([
      true,
      true,
    ]);
  });

  it("applies against the updater's latest chapter without overwriting concurrent edits", () => {
    const renderedChapter = makeChapter([
      makePage("p1", [makeBlock("one", { bold: false })]),
      makePage("p2", [makeBlock("two", { bold: false })]),
    ]);
    const latestChapter = makeChapter([
      makePage("p1", [
        makeBlock("one", {
          bold: false,
          translatedText: "newer translation",
        }),
      ]),
      makePage("p2", [
        makeBlock("two", { bold: false, reviewNote: "newer review note" }),
      ]),
    ]);
    const committed: ChapterSnapshot[] = [];
    const updateCurrentChapter = vi.fn(
      (...args: Parameters<UpdateCurrentChapter>) => {
        committed.push(args[1](latestChapter));
      },
    );

    const applied = applyGatherTextFormatRequest(
      renderedChapter,
      {
        targets: [
          { pageId: "p1", blockId: "one" },
          { pageId: "p2", blockId: "two" },
        ],
        patch: { bold: true },
      },
      updateCurrentChapter,
    );

    expect(applied).toBe(true);
    expect(committed[0]?.pages[0].blocks[0]).toMatchObject({
      bold: true,
      translatedText: "newer translation",
    });
    expect(committed[0]?.pages[1].blocks[0]).toMatchObject({
      bold: true,
      reviewNote: "newer review note",
    });
    expect(updateCurrentChapter.mock.calls[0][2]).toMatchObject({
      dirtyPageIds: ["p1", "p2"],
    });
  });

  it("does not record a no-op when the latest chapter already has the patch", () => {
    const renderedChapter = makeChapter([
      makePage("p1", [makeBlock("one", { bold: false })]),
    ]);
    const latestChapter = makeChapter([
      makePage("p1", [makeBlock("one", { bold: true })]),
    ]);
    const committed: ChapterSnapshot[] = [];
    const updateCurrentChapter = vi.fn(
      (...args: Parameters<UpdateCurrentChapter>) => {
        committed.push(args[1](latestChapter));
      },
    );

    const applied = applyGatherTextFormatRequest(
      renderedChapter,
      {
        targets: [{ pageId: "p1", blockId: "one" }],
        patch: { bold: true },
      },
      updateCurrentChapter,
    );

    expect(applied).toBe(false);
    expect(committed[0]).toBe(latestChapter);
    expect(updateCurrentChapter.mock.calls[0][2]).toMatchObject({
      dirtyPageIds: [],
    });
  });
});

function makeChapter(pages: MangaPage[]): ChapterSnapshot {
  return {
    id: "chapter",
    workId: "work",
    title: "Chapter",
    sourceKind: "images",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: TS,
    updatedAt: TS,
  };
}

function makePage(id: string, blocks: TranslationBlock[]): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks,
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeBlock(
  id: string,
  overrides: Partial<TranslationBlock> = {},
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 1, y: 2, w: 3, h: 4 },
    sourceText: `source-${id}`,
    translatedText: `translation-${id}`,
    confidence: 0.9,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "transparent",
    opacity: 1,
    reviewNote: "keep-me",
    ...overrides,
  };
}
