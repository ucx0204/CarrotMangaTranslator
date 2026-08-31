import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import {
  buildChapterSelectionRequests,
  resolveChapterTriState,
  resolveSelectedPageIds,
  toggleChapterSelection,
  togglePageSelection,
  type PageSelection,
} from "../src/renderer/src/lib/pageSelection";

const pages = [
  makePage("p1", "completed"),
  makePage("p2", "idle"),
  makePage("p3", "idle"),
];
const selectAll = { kind: "all" } as const;

describe("shared page selection", () => {
  it("resolves selected page ids for every selection kind", () => {
    expect(resolveSelectedPageIds(undefined, pages)).toEqual(new Set());
    expect(resolveSelectedPageIds(selectAll, pages)).toEqual(
      new Set(["p1", "p2", "p3"]),
    );
    expect(resolveSelectedPageIds({ kind: "pending" }, pages)).toEqual(
      new Set(["p2", "p3"]),
    );
    expect(
      resolveSelectedPageIds(
        { kind: "pages", pageIds: new Set(["p3"]) },
        pages,
      ),
    ).toEqual(new Set(["p3"]));
  });

  it("derives every chapter tri-state path", () => {
    expect(resolveChapterTriState(undefined, 3, pages)).toBe("none");
    expect(resolveChapterTriState(selectAll, 3, pages)).toBe("all");
    expect(resolveChapterTriState({ kind: "pending" }, 3)).toBe("some");
    expect(
      resolveChapterTriState({ kind: "pending" }, 2, [
        makePage("done", "completed"),
      ]),
    ).toBe("none");
    expect(
      resolveChapterTriState({ kind: "pending" }, 2, [
        makePage("a", "idle"),
        makePage("b", "idle"),
      ]),
    ).toBe("all");
    expect(resolveChapterTriState({ kind: "pending" }, 3, pages)).toBe("some");
    expect(
      resolveChapterTriState({ kind: "pages", pageIds: new Set() }, 0, []),
    ).toBe("none");
    expect(
      resolveChapterTriState(
        { kind: "pages", pageIds: new Set(["p1", "p2", "p3"]) },
        3,
      ),
    ).toBe("all");
    expect(
      resolveChapterTriState(
        { kind: "pages", pageIds: new Set(["p1"]) },
        3,
        pages,
      ),
    ).toBe("some");
  });

  it("toggles a chapter without mutating the input map", () => {
    const empty = new Map<string, PageSelection>();
    const selected = toggleChapterSelection(empty, "chapter", selectAll);
    expect(empty.has("chapter")).toBe(false);
    expect(selected.get("chapter")).toEqual(selectAll);
    expect(
      toggleChapterSelection(selected, "chapter", selectAll).has("chapter"),
    ).toBe(false);
  });

  it("toggles explicit pages, removes empty chapters, and preserves page order", () => {
    const initial = new Map<string, PageSelection>([
      ["chapter", { kind: "pending" }],
    ]);
    const removed = togglePageSelection(
      initial,
      "chapter",
      "p2",
      [makePage("p2", "idle")],
      { selectAll },
    );
    expect(removed.has("chapter")).toBe(false);

    const added = togglePageSelection(new Map(), "chapter", "p3", pages, {
      selectAll,
    });
    expect(added.get("chapter")).toEqual({
      kind: "pages",
      pageIds: new Set(["p3"]),
    });

    const reordered = togglePageSelection(
      new Map([
        [
          "chapter",
          { kind: "pages", pageIds: new Set(["p3"]) } as PageSelection,
        ],
      ]),
      "chapter",
      "p2",
      pages,
      { selectAll },
    );
    expect(reordered.get("chapter")).toEqual({
      kind: "pages",
      pageIds: new Set(["p2", "p3"]),
    });
  });

  it("optionally collapses a complete explicit set to all", () => {
    const collapsed = togglePageSelection(
      new Map([
        [
          "chapter",
          { kind: "pages", pageIds: new Set(["p1", "p2"]) } as PageSelection,
        ],
      ]),
      "chapter",
      "p3",
      pages,
      { collapseFullPageSetToAll: true, selectAll },
    );
    expect(collapsed.get("chapter")).toEqual(selectAll);

    const emptyPages = togglePageSelection(
      new Map(),
      "chapter",
      "unknown",
      [],
      { collapseFullPageSetToAll: true, selectAll },
    );
    expect(emptyPages.get("chapter")).toEqual({
      kind: "pages",
      pageIds: new Set(),
    });
  });

  it("builds ordered requests and drops missing, empty, and null-mode entries", () => {
    const map = new Map<string, PageSelection>([
      ["all", selectAll],
      ["pending", { kind: "pending" }],
      ["pages", { kind: "pages", pageIds: new Set(["p2"]) }],
      ["empty", { kind: "pages", pageIds: new Set() }],
    ]);

    expect(
      buildChapterSelectionRequests(
        ["missing", "all", "pending", "pages", "empty"],
        map,
        (selection) => (selection.kind === "all" ? "all" : null),
      ),
    ).toEqual([
      { chapterId: "all", mode: "all" },
      { chapterId: "pages", mode: "page-set", pageIds: ["p2"] },
    ]);
  });
});

function makePage(
  id: string,
  analysisStatus: MangaPage["analysisStatus"],
): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `C:/${id}.png`,
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
