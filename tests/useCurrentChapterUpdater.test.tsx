/** @vitest-environment jsdom */

import React from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type { WorkspaceHistoryController } from "../src/renderer/src/hooks/useWorkspaceHistory";
import { useCurrentChapterUpdater } from "../src/renderer/src/hooks/useCurrentChapterUpdater";

describe("useCurrentChapterUpdater", () => {
  it("keeps the updater stable when only aggregate option objects change", () => {
    const chapter = makeChapter();
    const currentChapterRef: React.MutableRefObject<ChapterSnapshot | null> = {
      current: chapter,
    };
    const markDirty = vi.fn();
    const setCurrentChapter =
      vi.fn<React.Dispatch<React.SetStateAction<ChapterSnapshot | null>>>();
    const recordChapterEdit = vi
      .fn<WorkspaceHistoryController["recordChapterEdit"]>()
      .mockReturnValue(true);
    const selectedBlockIds = ["block-1"];
    const { result, rerender } = renderHook(
      ({ progress }: { progress: number }) => {
        void progress;
        return useCurrentChapterUpdater({
          currentChapterRef,
          markDirty,
          setCurrentChapter,
          selection: {
            selectedPageId: "page-1",
            selectedBlockId: "block-1",
            selectedBlockIds,
          },
          workspaceHistory: { recordChapterEdit },
        });
      },
      { initialProps: { progress: 0 } },
    );
    const initialUpdater = result.current;

    rerender({ progress: 50 });

    expect(result.current).toBe(initialUpdater);
  });

  it("records only the page affected by a single-page edit", () => {
    const chapter = makeChapter();
    const currentChapterRef: React.MutableRefObject<ChapterSnapshot | null> = {
      current: chapter,
    };
    const markDirty = vi.fn();
    const setCurrentChapter =
      vi.fn<React.Dispatch<React.SetStateAction<ChapterSnapshot | null>>>();
    const recordChapterEdit = vi
      .fn<WorkspaceHistoryController["recordChapterEdit"]>()
      .mockReturnValue(true);
    const { result } = renderHook(() =>
      useCurrentChapterUpdater({
        currentChapterRef,
        markDirty,
        setCurrentChapter,
        selection: {
          selectedPageId: "page-1",
          selectedBlockId: "block-1",
          selectedBlockIds: ["block-1"],
        },
        workspaceHistory: { recordChapterEdit },
      }),
    );

    act(() => {
      result.current("page-1", (current) => ({
        ...current,
        pages: current.pages.map((page) =>
          page.id === "page-1"
            ? {
                ...page,
                blocks: page.blocks.map((block) => ({
                  ...block,
                  translatedText: "edited",
                })),
              }
            : page,
        ),
      }));
    });

    expect(markDirty).toHaveBeenCalledOnce();
    expect(markDirty).toHaveBeenCalledWith("page-1");
    expect(recordChapterEdit).toHaveBeenCalledOnce();
    const record = recordChapterEdit.mock.calls[0]?.[0];
    expect(record?.before.pages.map((page) => page.pageId)).toEqual(["page-1"]);
    expect(record?.after.pages.map((page) => page.pageId)).toEqual(["page-1"]);
    expect(record?.before.pages[0]?.blocks[0]?.translatedText).toBe("first");
    expect(record?.after.pages[0]?.blocks[0]?.translatedText).toBe("edited");
  });
});

function makeChapter(): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "Chapter",
    sourceKind: "images",
    status: "completed",
    pageOrder: ["page-1", "page-2"],
    pages: [
      makePage("page-1", "block-1", "first"),
      makePage("page-2", "block-2", "second"),
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(id: string, blockId: string, translatedText: string) {
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [
      {
        id: blockId,
        type: "nonsolid" as const,
        bbox: { x: 0, y: 0, w: 100, h: 100 },
        sourceText: "source",
        translatedText,
        confidence: 1,
        sourceDirection: "horizontal" as const,
        renderDirection: "horizontal" as const,
        fontSizePx: 20,
        lineHeight: 1.2,
        textAlign: "center" as const,
        textColor: "#000000",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
