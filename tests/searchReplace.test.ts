import { describe, expect, it } from "vitest";
import {
  applySearchReplace,
  compileSearchPattern,
  findSearchReplaceMatches,
  type SearchReplaceRequest,
} from "../src/renderer/src/lib/searchReplace";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("search and replace", () => {
  it("limits literal replacement to the current page and treats replacement tokens literally", () => {
    const chapter = makeChapter();
    const request = makeRequest({
      query: "A+B",
      replacement: "$& fixed",
      scope: "page",
    });

    const result = applySearchReplace(chapter, "page-a", request);

    expect(result.replacementCount).toBe(2);
    expect(result.changedPageIds).toEqual(["page-a"]);
    expect(result.chapter.pages[0]?.blocks[0]?.translatedText).toBe(
      "$& fixed and $& fixed",
    );
    expect(result.chapter.pages[1]?.blocks[1]?.translatedText).toBe(
      "A+B elsewhere",
    );
  });

  it("finds both fields across a chapter and supports regex capture replacement", () => {
    const chapter = makeChapter();
    const request = makeRequest({
      field: "both",
      query: "(hello)\\s+(world)",
      replacement: "$2, $1",
      scope: "chapter",
      useRegex: true,
    });

    expect(findSearchReplaceMatches(chapter, "page-a", request)).toMatchObject([
      { blockId: "a", field: "source", count: 1, pageId: "page-a" },
      { blockId: "b", field: "translated", count: 1, pageId: "page-b" },
    ]);

    const result = applySearchReplace(chapter, "page-a", request);
    expect(result.replacementCount).toBe(2);
    expect(result.changedPageIds).toEqual(["page-a", "page-b"]);
    expect(result.chapter.pages[0]?.blocks[0]?.sourceText).toBe("world, Hello");
    expect(result.chapter.pages[1]?.blocks[0]?.translatedText).toBe(
      "world, hello",
    );
  });

  it("surfaces invalid regular expressions before mutating the chapter", () => {
    expect(() =>
      compileSearchPattern(makeRequest({ query: "[", useRegex: true })),
    ).toThrow();
  });
});

function makeRequest(
  patch: Partial<SearchReplaceRequest> = {},
): SearchReplaceRequest {
  return {
    caseSensitive: false,
    field: "translated",
    query: "A+B",
    replacement: "fixed",
    scope: "page",
    useRegex: false,
    ...patch,
  };
}

function makeChapter(): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "Chapter",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page-a", "page-b"],
    pages: [
      makePage("page-a", [makeBlock("a", "Hello world", "A+B and a+b")]),
      makePage("page-b", [
        makeBlock("b", "source", "hello world"),
        makeBlock("c", "source", "A+B elsewhere"),
      ]),
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(id: string, blocks: TranslationBlock[]): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks,
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(
  id: string,
  sourceText: string,
  translatedText: string,
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 100 },
    sourceText,
    translatedText,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0.2,
  };
}
