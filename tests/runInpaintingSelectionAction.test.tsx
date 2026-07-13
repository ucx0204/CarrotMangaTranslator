// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { UseInpaintingActionsOptions } from "../src/renderer/src/hooks/inpaintingActionTypes";

const startInpainting = vi.hoisted(() => vi.fn());

vi.mock("../src/renderer/src/api/mangaGateway", () => ({
  mangaGateway: { startInpainting },
}));

import { useRunInpaintingSelectionAction } from "../src/renderer/src/hooks/useRunInpaintingSelectionAction";

const TS = "2026-01-01T00:00:00.000Z";

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "C:/page.png",
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [],
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeChapter(): ChapterSnapshot {
  const page = makePage();
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "completed",
    pageOrder: [page.id],
    pages: [page],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeOptions(
  overrides: Partial<UseInpaintingActionsOptions> = {},
): UseInpaintingActionsOptions {
  return {
    askConfirm: vi.fn().mockResolvedValue(true),
    clearPageImageCache: vi.fn(),
    clearRetouchHistory: vi.fn(),
    currentChapter: makeChapter(),
    dirty: true,
    jobActive: false,
    mergeLiveChapter: vi.fn(),
    patternMaskStrokes: [],
    pushStatus: vi.fn(),
    refreshLibrary: vi.fn().mockResolvedValue(undefined),
    saveNow: vi.fn().mockResolvedValue(undefined),
    selectedPage: makePage(),
    setInpaintingTool: vi.fn(),
    setJobState: vi.fn(),
    setPatternMaskStrokesByPage: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useRunInpaintingSelectionAction", () => {
  it("saves first, confirms once, starts the selection request, and merges the open chapter", async () => {
    const options = makeOptions();
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 1,
      blocksErased: 2,
    });
    const { result } = renderHook(() =>
      useRunInpaintingSelectionAction(options),
    );

    await act(() =>
      result.current([
        { chapterId: "chapter-1", mode: "page-set", pageIds: ["page-1"] },
      ]),
    );

    expect(options.saveNow).toHaveBeenCalledOnce();
    expect(options.askConfirm).toHaveBeenCalledOnce();
    expect(startInpainting).toHaveBeenCalledWith({
      mode: "selection-pattern",
      workId: "work-1",
      selections: [
        { chapterId: "chapter-1", mode: "page-set", pageIds: ["page-1"] },
      ],
    });
    expect(options.mergeLiveChapter).toHaveBeenCalledWith(makeChapter());
    expect(options.refreshLibrary).toHaveBeenCalledOnce();
    expect(vi.mocked(options.saveNow).mock.invocationCallOrder[0]).toBeLessThan(
      startInpainting.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not start when saving dirty edits fails", async () => {
    const options = makeOptions({
      saveNow: vi.fn().mockRejectedValue(new Error("save failed")),
    });
    const { result } = renderHook(() =>
      useRunInpaintingSelectionAction(options),
    );

    await act(() => result.current([{ chapterId: "chapter-1", mode: "all" }]));

    expect(startInpainting).not.toHaveBeenCalled();
    expect(options.setJobState).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });
});
