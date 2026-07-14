// @vitest-environment jsdom

import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InpaintingMaskStroke } from "../src/shared/inpaintingTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { UseInpaintingActionsOptions } from "../src/renderer/src/hooks/inpaintingActionTypes";
import type { UseInpaintingRetouchOptions } from "../src/renderer/src/hooks/inpaintingRetouchTypes";

const applyInpaintingRetouch = vi.hoisted(() => vi.fn());
const startInpainting = vi.hoisted(() => vi.fn());

vi.mock("../src/renderer/src/api/mangaGateway", () => ({
  mangaGateway: { applyInpaintingRetouch, startInpainting },
}));

import { useDrawnPatternInpaintingAction } from "../src/renderer/src/hooks/useDrawnPatternInpaintingAction";
import { useInpaintingRetouch } from "../src/renderer/src/hooks/useInpaintingRetouch";

const TS = "2026-01-01T00:00:00.000Z";
const MASK_STROKES: InpaintingMaskStroke[] = [
  {
    points: [
      { x: 100, y: 120 },
      { x: 150, y: 180 },
    ],
    radiusPx: 24,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("drawn-pattern image history", () => {
  it("records the transaction with before/after masks and clears the completed mask", async () => {
    const beforeChapter = makeChapter("before.png");
    const afterChapter = makeChapter("after-drawn.png");
    const recordImageEdit = vi.fn(() => true);
    const baseOptions = makeInpaintingOptions(beforeChapter, recordImageEdit);
    startInpainting.mockResolvedValue({
      status: "completed",
      chapter: afterChapter,
      pagesChanged: 1,
      blocksErased: 1,
      historyTransaction: { transactionId: "tx-drawn" },
    });
    const { result } = renderHook(() => {
      const [masksByPage, setMasksByPage] = React.useState<
        Record<string, InpaintingMaskStroke[]>
      >({ "page-1": MASK_STROKES });
      const run = useDrawnPatternInpaintingAction({
        ...baseOptions,
        patternMaskStrokes: masksByPage["page-1"] ?? [],
        setPatternMaskStrokesByPage: setMasksByPage,
      });
      return { masksByPage, run };
    });

    await act(() => result.current.run());

    expect(startInpainting).toHaveBeenCalledWith({
      chapterId: "chapter-1",
      mode: "page-pattern-drawn",
      pageId: "page-1",
      strokes: MASK_STROKES,
      featherPx: 8,
    });
    expect(recordImageEdit).toHaveBeenCalledOnce();
    expect(recordImageEdit).toHaveBeenCalledWith({
      label: "그린 영역 지우기",
      transactionId: "tx-drawn",
      mask: {
        before: {
          chapterId: "chapter-1",
          pageId: "page-1",
          strokes: MASK_STROKES,
        },
        after: {
          chapterId: "chapter-1",
          pageId: "page-1",
          strokes: [],
        },
      },
    });
    expect(result.current.masksByPage).toEqual({});
  });
});

describe("manual retouch image history", () => {
  it("records a successful immutable retouch transaction in workspace history", async () => {
    const beforeChapter = makeChapter("before.png");
    const afterChapter = makeChapter("after-retouch.png");
    const recordImageEdit = vi.fn(() => true);
    const mergeLiveChapter = vi.fn();
    const clearPageImageCache = vi.fn();
    const options: UseInpaintingRetouchOptions = {
      clearPageImageCache,
      currentChapter: beforeChapter,
      currentChapterRef: { current: beforeChapter },
      dirty: false,
      inpaintingBrushRadius: 32,
      inpaintingPaintColor: "#ffcc00",
      jobActive: false,
      mergeLiveChapter,
      pushStatus: vi.fn(),
      saveNow: vi.fn().mockResolvedValue(undefined),
      selectedPage: beforeChapter.pages[0] ?? null,
      setCurrentChapter: vi.fn(),
      workspaceHistory: { recordImageEdit },
    };
    applyInpaintingRetouch.mockResolvedValue({
      chapter: afterChapter,
      pageId: "page-1",
      historyTransaction: { transactionId: "tx-retouch" },
    });
    const { result } = renderHook(() => useInpaintingRetouch(options));
    const points = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ];

    await act(() => result.current.applyRetouchPoints("brush", points));

    expect(applyInpaintingRetouch).toHaveBeenCalledWith({
      chapterId: "chapter-1",
      pageId: "page-1",
      mode: "paint",
      points,
      radiusPx: 32,
      color: "#ffcc00",
      retainedInpaintedArtifactPaths: ["before.png"],
    });
    expect(clearPageImageCache).toHaveBeenCalledOnce();
    expect(mergeLiveChapter).toHaveBeenCalledWith(afterChapter);
    expect(recordImageEdit).toHaveBeenCalledOnce();
    expect(recordImageEdit).toHaveBeenCalledWith({
      label: "수동 보정",
      transactionId: "tx-retouch",
    });
    expect(result.current.retouchBusy).toBe(false);
  });
});

function makeInpaintingOptions(
  chapter: ChapterSnapshot,
  recordImageEdit: UseInpaintingActionsOptions["workspaceHistory"]["recordImageEdit"],
): UseInpaintingActionsOptions {
  return {
    askConfirm: vi.fn().mockResolvedValue(true),
    clearPageImageCache: vi.fn(),
    clearRetouchHistory: vi.fn(),
    currentChapter: chapter,
    dirty: false,
    jobActive: false,
    mergeLiveChapter: vi.fn(),
    patternMaskStrokes: MASK_STROKES,
    pushStatus: vi.fn(),
    refreshLibrary: vi.fn().mockResolvedValue(undefined),
    saveNow: vi.fn().mockResolvedValue(undefined),
    selectedPage: chapter.pages[0] ?? null,
    setInpaintingTool: vi.fn(),
    setJobState: vi.fn(),
    setPatternMaskStrokesByPage: vi.fn(),
    setPeekOriginal: vi.fn(),
    workspaceHistory: { recordImageEdit },
  };
}

function makeChapter(inpaintedImagePath: string): ChapterSnapshot {
  const page = makePage(inpaintedImagePath);
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

function makePage(inpaintedImagePath: string): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "original.png",
    inpaintedImagePath,
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks: [],
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}
