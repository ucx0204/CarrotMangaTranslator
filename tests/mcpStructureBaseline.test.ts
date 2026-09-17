/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { editingChapter } from "./mcpEditing.fixture";
import { useDeleteSelectedBlockAction } from "../src/renderer/src/hooks/useBlockReadingOrderActions";
import { useCurrentChapterUpdater } from "../src/renderer/src/hooks/useCurrentChapterUpdater";

/** Characterization of the UNCHANGED production editor. This is not a mock
 * implementation of the future split/merge/delete MCP service. */
function deletionFixture(
  options: {
    configure?: (chapter: ChapterSnapshot) => void;
    locked?: boolean;
    selectedId?: string;
  } = {},
) {
  const chapter = editingChapter();
  options.configure?.(chapter);
  const before = structuredClone(chapter);
  const ref: { current: ChapterSnapshot | null } = { current: chapter };
  const page = chapter.pages[0];
  const selected =
    page.blocks.find((block) => block.id === (options.selectedId ?? "a")) ??
    null;
  const assertPagesEditable = vi.fn();
  const markDirty = vi.fn();
  const setCurrentChapter = vi.fn();
  const recordChapterEdit = vi.fn();
  const setSelectedBlockId = vi.fn();
  const setSelectedBlockIds = vi.fn();
  const selection = {
    selectedPageId: page.id,
    selectedBlockId: selected?.id ?? null,
    selectedBlockIds: selected ? [selected.id] : [],
  };
  const { result } = renderHook(() => {
    const updateCurrentChapter = useCurrentChapterUpdater({
      currentChapterRef: ref,
      setCurrentChapter,
      markDirty,
      selection,
      workspaceHistory: { recordChapterEdit },
      assertPagesEditable,
    });
    return useDeleteSelectedBlockAction({
      currentChapter: chapter,
      selectedPage: page,
      selectedBlock: selected,
      selectedBlockIds: selection.selectedBlockIds,
      selectedPageEditLocked: options.locked ?? false,
      jobActive: false,
      readingDirection: "rtl",
      pushStatus: vi.fn(),
      setSelectedBlockId,
      setSelectedBlockIds,
      updateCurrentChapter,
    });
  });
  return {
    before,
    ref,
    assertPagesEditable,
    markDirty,
    setCurrentChapter,
    recordChapterEdit,
    setSelectedBlockId,
    setSelectedBlockIds,
    run: () => act(() => result.current()),
  };
}

afterEach(cleanup);

describe("structure editing baseline in the existing app", () => {
  it("deletes only the selected text object, retaining raster references and other pages", () => {
    const f = deletionFixture({
      configure: (chapter) => {
        chapter.pages.push({
          ...structuredClone(chapter.pages[0]),
          id: "other-page",
        });
        chapter.pageOrder.push("other-page");
      },
    });
    f.run();
    expect(f.ref.current).toEqual({
      ...f.before,
      pages: [
        {
          ...f.before.pages[0],
          blocks: [f.before.pages[0].blocks[1]],
          blockOrder: ["b"],
          updatedAt: expect.any(String),
        },
        f.before.pages[1],
      ],
    });
    expect(f.assertPagesEditable).toHaveBeenCalledWith(["page"]);
    expect(f.markDirty).toHaveBeenCalledExactlyOnceWith("page");
    expect(f.recordChapterEdit).toHaveBeenCalledOnce();
  });

  it("uses the explicit reading predecessor rather than block array position", () => {
    const f = deletionFixture();
    expect(f.before.pages[0].blocks.map((block) => block.id)).toEqual([
      "a",
      "b",
    ]);
    expect(f.before.pages[0].blockOrder).toEqual(["b", "a"]);
    f.run();
    expect(f.setSelectedBlockId).toHaveBeenCalledExactlyOnceWith("b");
    expect(f.setSelectedBlockIds).toHaveBeenCalledExactlyOnceWith(["b"]);
  });

  it("deleting the final block yields an empty reading order and selection", () => {
    const f = deletionFixture({
      configure: (chapter) => {
        chapter.pages[0].blocks.splice(1);
        chapter.pages[0].blockOrder = ["missing", "a", "a"];
      },
    });
    f.run();
    expect(f.ref.current?.pages[0]).toMatchObject({
      blocks: [],
      blockOrder: [],
    });
    expect(f.setSelectedBlockId).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.setSelectedBlockIds).toHaveBeenCalledExactlyOnceWith([]);
    expect(f.recordChapterEdit).toHaveBeenCalledOnce();
  });

  it("repairs stale reading IDs without mutating the retained block", () => {
    const f = deletionFixture({
      configure: (chapter) => {
        chapter.pages[0].blockOrder = ["missing", "b", "b", "a"];
      },
    });
    f.run();
    expect(f.ref.current?.pages[0].blockOrder).toEqual(["b"]);
    expect(f.ref.current?.pages[0].blocks).toEqual([
      f.before.pages[0].blocks[1],
    ]);
  });

  it("a visible page lock prevents mutation, history and selection changes", () => {
    const f = deletionFixture({ locked: true });
    f.run();
    expect(f.ref.current).toEqual(f.before);
    expect(f.assertPagesEditable).not.toHaveBeenCalled();
    expect(f.markDirty).not.toHaveBeenCalled();
    expect(f.recordChapterEdit).not.toHaveBeenCalled();
    expect(f.setSelectedBlockId).not.toHaveBeenCalled();
  });

  it("the shared edit guard still protects a stale unlocked UI before dirty state or history", () => {
    const f = deletionFixture();
    f.assertPagesEditable.mockImplementation(() => {
      throw new Error("page lease is now owned by MCP");
    });
    expect(f.run).toThrow("page lease is now owned by MCP");
    expect(f.ref.current).toEqual(f.before);
    expect(f.setCurrentChapter).not.toHaveBeenCalled();
    expect(f.markDirty).not.toHaveBeenCalled();
    expect(f.recordChapterEdit).not.toHaveBeenCalled();
    expect(f.setSelectedBlockId).not.toHaveBeenCalled();
    expect(f.setSelectedBlockIds).not.toHaveBeenCalled();
  });

  it("a missing selection cannot become an implicit whole-page deletion", () => {
    const f = deletionFixture({ selectedId: "missing" });
    f.run();
    expect(f.ref.current).toEqual(f.before);
    expect(f.assertPagesEditable).not.toHaveBeenCalled();
    expect(f.recordChapterEdit).not.toHaveBeenCalled();
  });
});
