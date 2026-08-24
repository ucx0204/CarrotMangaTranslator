import { describe, expect, it } from "vitest";
import type { MangaPage, PageAnalysisStatus } from "../src/shared/libraryTypes";
import {
  buildRunSelection,
  chapterTriState,
  selectedPageIds,
  toggleChapter,
  togglePage,
  type ChapterSelectionMap,
} from "../src/renderer/src/lib/translationSelection";

function makePage(id: string, status: PageAnalysisStatus): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `C:/${id}.png`,
    dataUrl: "",
    width: 100,
    height: 150,
    blocks: [],
    analysisStatus: status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const pages: MangaPage[] = [
  makePage("p1", "completed"),
  makePage("p2", "idle"),
  makePage("p3", "idle"),
];

describe("translation selection", () => {
  it("builds run selections in chapter order, dropping unselected and empty sets", () => {
    const map: ChapterSelectionMap = new Map([
      ["c1", { kind: "all" }],
      ["c2", { kind: "pending" }],
      ["c3", { kind: "pages", pageIds: new Set(["p2", "p3"]) }],
      ["c4", { kind: "pages", pageIds: new Set() }],
    ]);

    expect(buildRunSelection(["c1", "c2", "c3", "c4"], map)).toEqual([
      { chapterId: "c1", mode: "all" },
      { chapterId: "c2", mode: "pending" },
      { chapterId: "c3", mode: "page-set", pageIds: ["p2", "p3"] },
    ]);
  });

  it("emits run selections in the given chapter order, not map insertion order", () => {
    const map: ChapterSelectionMap = new Map([
      ["c2", { kind: "all" }],
      ["c1", { kind: "all" }],
    ]);

    expect(
      buildRunSelection(["c1", "c2"], map).map((sel) => sel.chapterId),
    ).toEqual(["c1", "c2"]);
  });

  it("toggles a whole chapter on and off", () => {
    const on = toggleChapter(new Map(), "c1");
    expect(on.get("c1")).toEqual({ kind: "all" });

    const off = toggleChapter(on, "c1");
    expect(off.has("c1")).toBe(false);
  });

  it("promotes a partially selected chapter to fully selected", () => {
    // Standard tri-state contract: indeterminate advances to checked rather
    // than clearing, so one stray click cannot discard a built-up selection.
    const partial: ChapterSelectionMap = new Map([
      ["c1", { kind: "pages", pageIds: new Set(["p2"]) }],
    ]);

    const next = toggleChapter(partial, "c1");

    expect(next.get("c1")).toEqual({ kind: "all" });
    expect(toggleChapter(next, "c1").has("c1")).toBe(false);
  });

  it("seeds an explicit page set from a pending chapter, then flips one page", () => {
    const map: ChapterSelectionMap = new Map([["c1", { kind: "pending" }]]);

    const next = togglePage(map, "c1", "p2", pages);

    expect(next.get("c1")).toEqual({
      kind: "pages",
      pageIds: new Set(["p3"]),
    });
  });

  it("deselects a chapter when its last page is unticked", () => {
    const map: ChapterSelectionMap = new Map([
      ["c1", { kind: "pages", pageIds: new Set(["p2"]) }],
    ]);

    const next = togglePage(map, "c1", "p2", pages);

    expect(next.has("c1")).toBe(false);
  });

  it("computes checked page ids for each selection kind", () => {
    expect(selectedPageIds({ kind: "all" }, pages)).toEqual(
      new Set(["p1", "p2", "p3"]),
    );
    expect(selectedPageIds({ kind: "pending" }, pages)).toEqual(
      new Set(["p2", "p3"]),
    );
    expect(
      selectedPageIds({ kind: "pages", pageIds: new Set(["p1"]) }, pages),
    ).toEqual(new Set(["p1"]));
    expect(selectedPageIds(undefined, pages)).toEqual(new Set());
  });

  it("derives a chapter checkbox tri-state", () => {
    expect(chapterTriState(undefined, 3, pages)).toBe("none");
    expect(chapterTriState({ kind: "all" }, 3, pages)).toBe("all");
    expect(chapterTriState({ kind: "pending" }, 3, pages)).toBe("some");
    expect(
      chapterTriState(
        { kind: "pages", pageIds: new Set(["p1", "p2", "p3"]) },
        3,
        pages,
      ),
    ).toBe("all");
    expect(chapterTriState({ kind: "pending" }, 3)).toBe("some");
  });
});
