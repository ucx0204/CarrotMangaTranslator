import { useInpaintingActions } from "../src/renderer/src/hooks/useInpaintingActions";
// @vitest-environment jsdom

import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { InpaintingMaskStroke } from "../src/shared/inpaintingTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { UseInpaintingActionsOptions } from "../src/renderer/src/hooks/inpaintingActionTypes";
import type { UseInpaintingRetouchOptions } from "../src/renderer/src/hooks/inpaintingRetouchTypes";

const applyInpaintingRetouch = vi.fn();
const startInpainting = vi.fn();

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    applyInpaintingRetouch,
    startInpainting,
  });
});

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
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("drawn-pattern image history", () => {
  it.each([undefined, "codex"] as const)(
    "records the %s transaction with before/after masks and clears the completed mask",
    async (engine) => {
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
          codexErasureAvailable: true,
          patternMaskStrokes: masksByPage["page-1"] ?? [],
          setPatternMaskStrokesByPage: setMasksByPage,
        });
        return { masksByPage, run };
      });

      await act(() => result.current.run(engine));

      expect(startInpainting).toHaveBeenCalledWith({
        chapterId: "chapter-1",
        mode: "page-pattern-drawn",
        pageId: "page-1",
        strokes: MASK_STROKES,
        featherPx: 8,
        ...(engine ? { engine } : {}),
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
    },
  );
  it("saves only the target and preserves mask strokes added while ImageGen is running", async () => {
    const chapter = makeChapter("before.png");
    const record = vi.fn(() => true);
    const options = makeInpaintingOptions(chapter, record);
    options.dirty = true;
    options.savePageNow = vi.fn(async () => undefined);
    let finish!: (value: unknown) => void;
    startInpainting.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => {
      const [masks, setMasks] = React.useState<
        Record<string, InpaintingMaskStroke[]>
      >({ "page-1": structuredClone(MASK_STROKES) });
      const masksRef = React.useRef(masks);
      masksRef.current = masks;
      const run = useDrawnPatternInpaintingAction({
        ...options,
        patternMaskStrokes: masks["page-1"],
        getPatternMaskStrokes: (pageId) => masksRef.current[pageId] ?? [],
        setPatternMaskStrokesByPage: setMasks,
      });
      return { masks, setMasks, run };
    });
    let running!: Promise<void>;
    await act(async () => {
      running = result.current.run();
      await Promise.resolve();
    });
    const extra = { points: [{ x: 20, y: 30 }], radiusPx: 10 };
    act(() => result.current.setMasks({ "page-1": [...MASK_STROKES, extra] }));
    await act(async () => {
      finish({
        status: "completed",
        chapter,
        historyTransaction: { transactionId: "tx-new" },
      });
      await running;
    });
    expect(options.savePageNow).toHaveBeenCalledWith(chapter.id, "page-1");
    expect(options.saveNow).not.toHaveBeenCalled();
    expect(startInpainting.mock.calls[0][0].strokes).toEqual(MASK_STROKES);
    expect(result.current.masks["page-1"]).toEqual([...MASK_STROKES, extra]);
    expect(record).toHaveBeenCalledWith(
      expect.not.objectContaining({ mask: expect.anything() }),
    );
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
    expect(result.current.appendRetouchPoint({ x: 10.1, y: 20.2 })).toEqual({
      x: 10,
      y: 20,
    });
    expect(result.current.appendRetouchPoint({ x: 11, y: 21 })).toBeNull();
    expect(result.current.appendRetouchPoint({ x: 30, y: 40 })).toEqual({
      x: 30,
      y: 40,
    });
    const points = [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ];

    await act(() =>
      result.current.applyRetouchOperation({
        geometry: { kind: "stroke", points, radiusPx: 32 },
        mode: "paint",
      }),
    );

    expect(applyInpaintingRetouch).toHaveBeenCalledWith({
      chapterId: "chapter-1",
      pageId: "page-1",
      expectedRevision: expect.stringMatching(/^page-v1:/),
      mode: "paint",
      geometry: { kind: "stroke", points, radiusPx: 32 },
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
    setFlowActive: vi.fn(),
    setInpaintingTool: vi.fn(),
    setJobState: vi.fn(),
    setPatternMaskStrokesByPage: vi.fn(),
    setPeekOriginal: vi.fn(),
    setShowBlockChrome: vi.fn(),
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

it("mounts all image/export actions while another page's model job is active", () => {
  const options = {
    ...makeInpaintingOptions(
      makeChapter("paint.png"),
      vi.fn(() => true),
    ),
    modelResourceBusy: true,
  };
  const { result } = renderHook(() => useInpaintingActions(options));
  expect(result.current.exportPageImages).toBeTypeOf("function");
  expect(result.current.exportPagePsd).toBeTypeOf("function");
  expect(result.current.actionBusy).toBe(false);
});

it("allows a remote mask with a local model busy and preserves its selected progress", async () => {
  const foreground = {
    id: "translation",
    kind: "gemma-analysis" as const,
    status: "running" as const,
    progressText: "A 번역",
  };
  const base = makeInpaintingOptions(
    makeChapter("paint.png"),
    vi.fn(() => true),
  );
  startInpainting.mockResolvedValue({
    status: "completed",
    chapter: makeChapter("remote.png"),
  });
  const { result } = renderHook(() => {
    const [job, setJob] = React.useState(foreground);
    const actions = useInpaintingActions({
      ...base,
      modelResourceBusy: true,
      codexErasureAvailable: true,
      codexErasureBusy: false,
      setJobState: setJob as UseInpaintingActionsOptions["setJobState"],
    });
    return { job, actions };
  });
  await act(() => result.current.actions.runDrawnPatternInpainting("codex"));
  expect(startInpainting).toHaveBeenCalledOnce();
  expect(result.current.job).toBe(foreground);
  await act(() => result.current.actions.runDrawnPatternInpainting());
  expect(startInpainting).toHaveBeenCalledOnce();
});

it("keeps mask strokes drawn after the submitted mask snapshot", async () => {
  let complete: ((value: unknown) => void) | undefined;
  startInpainting.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const recordImageEdit = vi.fn<(entry: unknown) => boolean>(() => true);
  const base = makeInpaintingOptions(
    makeChapter("before.png"),
    recordImageEdit,
  );
  const masks = { current: structuredClone(MASK_STROKES) };
  const setMasks = vi.fn();
  const { result } = renderHook(() =>
    useDrawnPatternInpaintingAction({
      ...base,
      getPatternMaskStrokes: () => masks.current,
      setPatternMaskStrokesByPage: setMasks,
    }),
  );
  let pending: Promise<void> | undefined;
  await act(async () => {
    pending = result.current();
  });
  expect(startInpainting).toHaveBeenCalledOnce();
  const extra = { points: [{ x: 280, y: 300 }], radiusPx: 10 };
  masks.current = [...MASK_STROKES, extra];
  if (!complete) throw new Error("Expected inpainting request.");
  complete({
    status: "completed",
    chapter: makeChapter("after.png"),
    historyTransaction: { transactionId: "late-image" },
  });
  await act(async () => {
    await pending;
  });
  expect(startInpainting.mock.calls[0][0].strokes).toEqual(MASK_STROKES);
  expect(recordImageEdit.mock.calls[0][0]).not.toHaveProperty("mask");
  const apply = setMasks.mock.calls[0][0];
  const current = { "page-1": masks.current };
  expect(apply(current)).toBe(current);
});
