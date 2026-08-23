/** @vitest-environment jsdom */

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BlockLibraryEntryV1 } from "../src/shared/blockLibrary";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import {
  resolveVisibleStageCenter,
  useInsertBlockLibraryEntryAction,
} from "../src/renderer/src/hooks/useBlockReadingOrderActions";

describe("library block insertion", () => {
  it("centers a fresh block and records the whole insertion as one undo step", () => {
    const page = makePage();
    const chapter: ChapterSnapshot = makeChapter(page);
    const setSelectedBlockId = vi.fn();
    const setSelectedBlockIds = vi.fn();
    const updateCurrentChapter = vi.fn((pageId, updater, options) => {
      expect(pageId).toBe(page.id);
      const next = updater(chapter);
      const inserted = next.pages[0]?.blocks[0];
      expect(inserted?.id).toContain(`${page.id}-library-`);
      expect(inserted?.renderBbox).toEqual({ x: 350, y: 400, w: 300, h: 200 });
      expect(next.pages[0]?.blockOrder).toEqual([inserted?.id]);
      expect(options.selectionAfter).toEqual({
        selectedPageId: page.id,
        selectedBlockId: inserted?.id,
        selectedBlockIds: [inserted?.id],
      });
      expect(options.label).toBeTruthy();
    });
    const { result } = renderHook(() =>
      useInsertBlockLibraryEntryAction({
        currentChapter: chapter,
        jobActive: false,
        pushStatus: vi.fn(),
        selectedBlock: null,
        selectedBlockIds: [],
        selectedPage: page,
        selectedPageEditLocked: false,
        setSelectedBlockId,
        setSelectedBlockIds,
        updateCurrentChapter,
      }),
    );

    result.current(makeEntry());

    expect(updateCurrentChapter).toHaveBeenCalledOnce();
    expect(setSelectedBlockId).toHaveBeenCalledOnce();
    expect(setSelectedBlockIds).toHaveBeenCalledOnce();
  });

  it("uses the center of the currently visible page area", () => {
    const workspace = document.createElement("div");
    workspace.className = "workspace";
    const stage = document.createElement("div");
    workspace.append(stage);
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue(
      rect(100, 100, 400, 400),
    );
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(
      rect(-100, 0, 1000, 1000),
    );

    expect(resolveVisibleStageCenter(stage)).toEqual({ x: 400, y: 300 });
  });
});

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "1.png",
    imagePath: "C:/fixture/1.png",
    dataUrl: "data:image/png;base64,fixture",
    width: 1000,
    height: 1600,
    blocks: [],
    analysisStatus: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeEntry(): BlockLibraryEntryV1 {
  return {
    schemaVersion: 1,
    id: "entry-1",
    name: "의성어",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    block: {
      sourceText: "ドン",
      translatedText: "쾅",
      sourceDirection: "vertical",
      renderDirection: "vertical",
      fontSizePx: 64,
      lineHeight: 1.1,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#ffffff",
      opacity: 0.7,
      size: { w: 300, h: 200 },
    },
  };
}
