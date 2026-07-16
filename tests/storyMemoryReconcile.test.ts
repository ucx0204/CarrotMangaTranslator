import { describe, expect, it } from "vitest";
import { reconcilePageStoryMemories } from "../src/main/libraryStore/storyMemoryReconcile";
import type { PageStoryMemory } from "../src/shared/workContextTypes";

const TS = "2026-01-01T00:00:00.000Z";

describe("page story memory reconciliation", () => {
  it("drops deleted pages and rewrites indices after reordering", () => {
    const pageOne = makeMemory("page-1", "old-1.png", 0);
    const pageTwo = makeMemory("page-2", "old-2.png", 1);
    const deleted = makeMemory("deleted", "deleted.png", 2);

    const result = reconcilePageStoryMemories(
      [pageOne, pageTwo, deleted],
      [
        { id: "page-2", name: "002.png" },
        { id: "page-1", name: "001.png" },
      ],
    );

    expect(result).toEqual([
      expect.objectContaining({
        pageId: "page-2",
        pageName: "002.png",
        pageIndex: 0,
      }),
      expect.objectContaining({
        pageId: "page-1",
        pageName: "001.png",
        pageIndex: 1,
      }),
    ]);
    expect(result.some((memory) => memory.pageId === "deleted")).toBe(false);
  });

  it("preserves object identity when the live order is already canonical", () => {
    const page = makeMemory("page-1", "001.png", 0);
    expect(
      reconcilePageStoryMemories([page], [{ id: "page-1", name: "001.png" }]),
    ).toEqual([page]);
    expect(
      reconcilePageStoryMemories(
        [page],
        [{ id: "page-1", name: "001.png" }],
      )[0],
    ).toBe(page);
  });
});

function makeMemory(
  pageId: string,
  pageName: string,
  pageIndex: number,
): PageStoryMemory {
  return {
    pageId,
    pageName,
    pageIndex,
    sourceDigest: "",
    translatedDigest: "",
    summary: "",
    updatedAt: TS,
  };
}
