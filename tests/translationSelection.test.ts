import { describe, expect, it } from "vitest";
import type { MangaPage, PageAnalysisStatus } from "../src/shared/libraryTypes";
import { createPageRevision } from "../src/shared/pageRevision";
import {
  applyPageRangeFromAnchor,
  buildRunSelection,
  chapterTriState,
  createPendingChapterSelection,
  pageRunIntent,
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

    expect(buildRunSelection(["missing", "c1", "c2", "c3", "c4"], map)).toEqual(
      [
        { chapterId: "c1", mode: "all" },
        { chapterId: "c2", mode: "pending" },
        {
          chapterId: "c3",
          mode: "page-set",
          pageIds: ["p2", "p3"],
          restartPageIds: ["p2", "p3"],
        },
      ],
    );
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
      restartPageIds: new Set(["p3"]),
    });
  });

  it("cycles a resumable page from resume to restart to excluded and back", () => {
    const page = withCheckpoint(makePage("checkpoint", "idle"));
    const initial = createPendingChapterSelection([page], {
      blockMode: "auto",
      sourceLanguage: "ja",
      targetLanguage: "ko",
    });
    expect(initial).toBeDefined();
    if (!initial) throw new Error("resume selection missing");
    let selection: ChapterSelectionMap = new Map([["c1", initial]]);
    expect(pageRunIntent(selection.get("c1"), page)).toBe("resume");

    selection = togglePage(selection, "c1", page.id, [page]);
    expect(pageRunIntent(selection.get("c1"), page)).toBe("restart");

    selection = togglePage(selection, "c1", page.id, [page]);
    expect(pageRunIntent(selection.get("c1"), page)).toBe("none");

    selection = togglePage(selection, "c1", page.id, [page]);
    expect(pageRunIntent(selection.get("c1"), page)).toBe("resume");
  });

  it("applies the anchor page intent across an inclusive range in either direction", () => {
    const initial: ChapterSelectionMap = new Map([
      [
        "c1",
        {
          kind: "pages",
          pageIds: new Set(["p3"]),
          restartPageIds: new Set(["p3"]),
        },
      ],
    ]);

    const next = applyPageRangeFromAnchor(initial, "c1", "p3", "p1", pages);

    expect(next.get("c1")).toEqual({
      kind: "pages",
      pageIds: new Set(["p1", "p2", "p3"]),
      restartPageIds: new Set(["p1", "p2", "p3"]),
    });
  });

  it("leaves selection unchanged when either range endpoint is unavailable", () => {
    const initial: ChapterSelectionMap = new Map([["c1", { kind: "all" }]]);

    expect(
      applyPageRangeFromAnchor(initial, "c1", "missing", "p2", pages),
    ).toBe(initial);
    expect(
      applyPageRangeFromAnchor(initial, "c1", "p2", "missing", pages),
    ).toBe(initial);
  });

  it("applies an excluded anchor by removing the inclusive range", () => {
    const initial: ChapterSelectionMap = new Map([
      [
        "c1",
        {
          kind: "pages",
          pageIds: new Set(["p2", "p3"]),
          restartPageIds: new Set(["p2", "p3"]),
        },
      ],
    ]);

    const next = applyPageRangeFromAnchor(initial, "c1", "p1", "p2", pages);

    expect(next.get("c1")).toEqual({
      kind: "pages",
      pageIds: new Set(["p3"]),
      restartPageIds: new Set(["p3"]),
    });
  });

  it("promotes non-resumable pages to restart inside a resume range", () => {
    const resumableFirst = withCheckpoint(makePage("resume-1", "idle"));
    const restartOnly = makePage("restart", "idle");
    const resumableLast = withCheckpoint(makePage("resume-2", "idle"));
    const rangePages = [resumableFirst, restartOnly, resumableLast];
    const initial: ChapterSelectionMap = new Map([
      [
        "c1",
        {
          kind: "pages",
          pageIds: new Set([resumableFirst.id]),
          restartPageIds: new Set(),
        },
      ],
    ]);

    const next = applyPageRangeFromAnchor(
      initial,
      "c1",
      resumableFirst.id,
      resumableLast.id,
      rangePages,
      { blockMode: "auto", sourceLanguage: "ja", targetLanguage: "ko" },
    );

    expect(pageRunIntent(next.get("c1"), resumableFirst)).toBe("resume");
    expect(pageRunIntent(next.get("c1"), restartOnly)).toBe("restart");
    expect(pageRunIntent(next.get("c1"), resumableLast)).toBe("resume");
  });

  it("puts checkpoints in resume and untreated pages in restart for pending", () => {
    const checkpoint = withCheckpoint(makePage("checkpoint", "idle"));
    const untreated = makePage("new", "idle");
    const completed = makePage("done", "completed");

    expect(
      createPendingChapterSelection([checkpoint, untreated, completed], {
        blockMode: "auto",
        sourceLanguage: "ja",
        targetLanguage: "ko",
      }),
    ).toEqual({
      kind: "pages",
      pageIds: new Set(["checkpoint", "new"]),
      restartPageIds: new Set(["new"]),
    });
    expect(
      createPendingChapterSelection([completed], {
        blockMode: "auto",
        sourceLanguage: "ja",
        targetLanguage: "ko",
      }),
    ).toBeUndefined();
  });

  it("promotes a language-incompatible checkpoint to restart", () => {
    const page = withCheckpoint(makePage("checkpoint", "idle"));
    const selection = createPendingChapterSelection([page], {
      blockMode: "auto",
      sourceLanguage: "en",
      targetLanguage: "ko",
    });

    expect(selection).toEqual({
      kind: "pages",
      pageIds: new Set([page.id]),
      restartPageIds: new Set([page.id]),
    });
  });

  it("deselects a chapter when its last page is unticked", () => {
    const map: ChapterSelectionMap = new Map([
      ["c1", { kind: "pages", pageIds: new Set(["p2"]) }],
    ]);

    const next = togglePage(map, "c1", "p2", pages);

    expect(next.has("c1")).toBe(false);
    expect(togglePage(map, "c1", "missing", pages)).toBe(map);
    expect(togglePage(new Map(), "c1", "p2", pages).get("c1")).toEqual({
      kind: "pages",
      pageIds: new Set(["p2"]),
      restartPageIds: new Set(["p2"]),
    });
  });

  it("computes checked page ids for each selection kind", () => {
    const firstPage = pages[0];
    if (!firstPage) throw new Error("selection fixture requires one page");
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
    expect(pageRunIntent({ kind: "all" }, firstPage)).toBe("restart");
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
    expect(
      chapterTriState(
        { kind: "pages", pageIds: new Set(), restartPageIds: new Set() },
        3,
        pages,
      ),
    ).toBe("none");
  });

  it("resumes only matching unfinished postprocessing receipts", () => {
    const page: MangaPage = {
      ...makePage("postprocess", "completed"),
      translationCompletion: {
        workflow: "bubble-layout",
        status: "pending",
      },
    };
    const context = {
      blockMode: "auto" as const,
      sourceLanguage: "ja",
      targetLanguage: "ko",
      completionWorkflow: "bubble-layout" as const,
    };

    expect(pageRunIntent({ kind: "pending" }, page, context)).toBe("resume");
    expect(
      pageRunIntent(
        { kind: "pending" },
        {
          ...page,
          translationCompletion: {
            workflow: "bubble-layout",
            status: "completed",
          },
        },
        context,
      ),
    ).toBe("none");
  });
});

function withCheckpoint(page: MangaPage): MangaPage {
  return {
    ...page,
    translationCheckpoint: {
      schemaVersion: 1,
      pipelineContractVersion: "whole-page-prepared-v1",
      artifactPath: ".translation-checkpoint-test/checkpoint.json",
      sha256: "a".repeat(64),
      byteSize: 100,
      inputRevision: createPageRevision(page),
      sourceLanguage: "ja",
      targetLanguage: "ko",
      blockMode: "auto",
      savedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}
