import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import {
  buildExportSelection,
  createDefaultExportSelection,
  exportChapterTriState,
  selectedExportPageIds,
  toggleExportChapter,
  toggleExportPage,
  type ExportSelectionMap,
} from "../src/renderer/src/lib/exportSelection";

function makePage(id: string): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `C:/${id}.png`,
    dataUrl: "",
    width: 100,
    height: 150,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const pages = [makePage("p1"), makePage("p2"), makePage("p3")];

describe("export selection", () => {
  it("defaults to only the current page", () => {
    expect(
      buildExportSelection(["c1"], createDefaultExportSelection("c1", "p2")),
    ).toEqual([{ chapterId: "c1", mode: "page-set", pageIds: ["p2"] }]);
  });

  it("builds all and page-set requests in library chapter order", () => {
    const selection: ExportSelectionMap = new Map([
      ["c2", { kind: "pages", pageIds: new Set(["p3", "p1"]) }],
      ["c1", { kind: "all" }],
    ]);

    expect(buildExportSelection(["c1", "c2"], selection)).toEqual([
      { chapterId: "c1", mode: "all" },
      { chapterId: "c2", mode: "page-set", pageIds: ["p3", "p1"] },
    ]);
  });

  it("toggles chapters and pages without introducing a pending mode", () => {
    const wholeChapter = toggleExportChapter(new Map(), "c1");
    expect(wholeChapter.get("c1")).toEqual({ kind: "all" });

    const withoutMiddle = toggleExportPage(wholeChapter, "c1", "p2", pages);
    expect(withoutMiddle.get("c1")).toEqual({
      kind: "pages",
      pageIds: new Set(["p1", "p3"]),
    });
    expect(selectedExportPageIds(withoutMiddle.get("c1"), pages)).toEqual(
      new Set(["p1", "p3"]),
    );
    expect(toggleExportChapter(withoutMiddle, "c1").get("c1")).toEqual({
      kind: "all",
    });

    const allAgain = toggleExportPage(withoutMiddle, "c1", "p2", pages);
    expect(allAgain.get("c1")).toEqual({ kind: "all" });
    expect(toggleExportChapter(allAgain, "c1").has("c1")).toBe(false);
  });

  it("derives checkbox state from all, partial, and empty selections", () => {
    expect(exportChapterTriState(undefined, pages.length, pages)).toBe("none");
    expect(exportChapterTriState({ kind: "all" }, pages.length)).toBe("all");
    expect(
      exportChapterTriState(
        { kind: "pages", pageIds: new Set(["p1"]) },
        pages.length,
        pages,
      ),
    ).toBe("some");
    expect(
      exportChapterTriState(
        { kind: "pages", pageIds: new Set(pages.map((page) => page.id)) },
        pages.length,
        pages,
      ),
    ).toBe("all");
  });

  it("drops empty page sets from the request", () => {
    expect(
      buildExportSelection(
        ["c1"],
        new Map([["c1", { kind: "pages", pageIds: new Set() }]]),
      ),
    ).toEqual([]);
  });
});
