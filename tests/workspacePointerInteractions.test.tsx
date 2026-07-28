// @vitest-environment jsdom

import React, {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { InpaintingMaskStroke } from "../src/shared/inpaintingTypes";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { BBox, TranslationBlock } from "../src/shared/textTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { ImageStage } from "../src/renderer/src/components/ImageStage";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";
import { useWorkspacePointerHandlers } from "../src/renderer/src/hooks/useWorkspacePointerHandlers";
import type { InpaintingTool } from "../src/renderer/src/inpainting/inpaintingTypes";
import type { RegionSelectionState } from "../src/renderer/src/lib/appHelpers";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import type { StageTool } from "../src/renderer/src/lib/stageTool";

type UpdateCurrentChapterMock = ReturnType<
  typeof createUpdateCurrentChapterMock
>;
type TranslateSelectedRegionMock = ReturnType<
  typeof createTranslateSelectedRegionMock
>;

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const fontsContext: FontsContextValue = {
  baseOptions: [],
  busy: false,
  catalog: DEFAULT_BLOCK_FONT_CATALOG,
  options: [],
  registerFont: async () => undefined,
  removeFont: async () => undefined,
  savePreferences: async () => undefined,
};

type HarnessApi = {
  getBounds: ReturnType<typeof vi.fn>;
  getBlockCreateRect: () => BBox | null;
  getBlockPreview: () => TranslationBlock | null;
  getRenderCount: () => number;
  getRegionSelection: () => RegionSelectionState | null;
  getRegionSelectionPreview: () => BBox | null;
  getSelectedBlockId: () => string | null;
  startRegionTranslationSelection: () => void;
  statuses: string[];
  translateSelectedRegion: TranslateSelectedRegionMock;
  updateCurrentChapter: UpdateCurrentChapterMock;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
    }),
  });
});

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
});

describe("workspace pointer interactions", () => {
  it("keeps live drag previews active under renderer StrictMode", () => {
    const frames = installAnimationFrameController();
    const api = renderHarness({
      initialSelectedBlockId: "block-1",
      renderOverlay: true,
      strictMode: true,
    });
    const block = document.querySelector<HTMLElement>(".overlay-block");
    const stage = document.querySelector<HTMLElement>(".image-stage");
    expect(block).not.toBeNull();
    expect(stage).not.toBeNull();

    fireEvent.pointerDown(block as HTMLElement, {
      clientX: 20,
      clientY: 20,
      pointerId: 7,
    });
    fireEvent.pointerMove(stage as HTMLElement, {
      clientX: 80,
      clientY: 80,
      pointerId: 7,
    });
    act(() => frames.flush());

    expect(api.current.getBlockPreview()?.bbox).toMatchObject({
      x: 700,
      y: 700,
    });
    expect(
      document.querySelector<HTMLElement>(".overlay-block")?.style.transform,
    ).toContain("translate3d(70px, 70px, 0)");
    expect(api.current.updateCurrentChapter).not.toHaveBeenCalled();

    fireEvent.pointerUp(stage as HTMLElement, {
      clientX: 80,
      clientY: 80,
      pointerId: 7,
    });
    expect(api.current.updateCurrentChapter).toHaveBeenCalledTimes(1);
  });

  it("keeps a drag burst out of chapter state and commits the final position once", () => {
    const frames = installAnimationFrameController();
    const api = renderHarness({ initialSelectedBlockId: "block-1" });
    const block = screen.getByTestId("block");
    const stage = screen.getByTestId("stage");

    fireEvent.pointerDown(block, {
      clientX: 20,
      clientY: 20,
      pointerId: 7,
    });
    const renderCountAfterPointerDown = api.current.getRenderCount();
    for (let coordinate = 21; coordinate <= 80; coordinate += 1) {
      fireEvent.pointerMove(stage, {
        clientX: coordinate,
        clientY: coordinate,
        pointerId: 7,
      });
    }

    expect(api.current.getRenderCount()).toBe(renderCountAfterPointerDown);
    expect(api.current.getBounds).toHaveBeenCalledTimes(1);
    expect(api.current.updateCurrentChapter).not.toHaveBeenCalled();
    expect(frames.count()).toBe(1);

    act(() => frames.flush());
    expect(api.current.getBlockPreview()?.bbox.x).toBe(700);

    fireEvent.pointerUp(stage, {
      clientX: 80,
      clientY: 80,
      pointerId: 7,
    });

    expect(api.current.updateCurrentChapter).toHaveBeenCalledTimes(1);
    const updater = api.current.updateCurrentChapter.mock.calls[0]?.[1];
    const page = makePage();
    expect(updater?.(makeChapter(page)).pages[0]?.blocks[0]?.bbox.x).toBe(700);
    expect(api.current.getBlockPreview()).toBeNull();
  });

  it("keeps region and block-create marquee bursts outside root React state", () => {
    const frames = installAnimationFrameController();
    const regionApi = renderHarness();
    const regionStage = screen.getByTestId("stage");
    act(() => regionApi.current.startRegionTranslationSelection());
    fireEvent.pointerDown(regionStage, {
      clientX: 10,
      clientY: 10,
      pointerId: 3,
    });
    const regionRenderCount = regionApi.current.getRenderCount();
    for (let coordinate = 20; coordinate <= 70; coordinate += 1) {
      fireEvent.pointerMove(regionStage, {
        clientX: coordinate,
        clientY: coordinate,
        pointerId: 3,
      });
    }
    expect(regionApi.current.getRenderCount()).toBe(regionRenderCount);
    expect(regionApi.current.getBounds).toHaveBeenCalledTimes(1);
    expect(frames.count()).toBe(1);
    act(() => frames.flush());
    expect(regionApi.current.getRegionSelectionPreview()).toEqual({
      h: 600,
      w: 600,
      x: 100,
      y: 100,
    });
    fireEvent.pointerUp(regionStage, {
      clientX: 70,
      clientY: 70,
      pointerId: 3,
    });
    expect(regionApi.current.translateSelectedRegion).toHaveBeenCalledTimes(1);
    cleanup();

    const blockApi = renderHarness({ stageTool: "block" });
    const blockStage = screen.getByTestId("stage");
    fireEvent.pointerDown(blockStage, {
      button: 0,
      clientX: 15,
      clientY: 15,
      pointerId: 4,
    });
    const blockRenderCount = blockApi.current.getRenderCount();
    for (let coordinate = 20; coordinate <= 75; coordinate += 1) {
      fireEvent.pointerMove(blockStage, {
        clientX: coordinate,
        clientY: coordinate,
        pointerId: 4,
      });
    }
    expect(blockApi.current.getRenderCount()).toBe(blockRenderCount);
    expect(blockApi.current.getBounds).toHaveBeenCalledTimes(1);
    expect(frames.count()).toBe(1);
    act(() => frames.flush());
    expect(blockApi.current.getBlockCreateRect()?.w).toBe(600);
    fireEvent.pointerUp(blockStage, {
      clientX: 75,
      clientY: 75,
      pointerId: 4,
    });
    expect(blockApi.current.updateCurrentChapter).toHaveBeenCalledTimes(1);
  });

  it("cancels an active region selection with Escape", () => {
    const api = renderHarness();

    act(() => {
      api.current.startRegionTranslationSelection();
    });
    expect(api.current.getRegionSelection()?.active).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(api.current.getRegionSelection()).toBeNull();
    expect(api.current.statuses).toContain("영역 번역 선택을 취소했습니다.");
  });

  it("does not arm region translation until the selected page image is ready", () => {
    const api = renderHarness({ regionTranslationReady: false });

    act(() => {
      api.current.startRegionTranslationSelection();
    });

    expect(api.current.getRegionSelection()).toBeNull();
  });

  it("rejects tiny region translation selections without starting translation", () => {
    const api = renderHarness();
    const stage = screen.getByTestId("stage");

    act(() => {
      api.current.startRegionTranslationSelection();
    });
    act(() => {
      fireEvent.pointerDown(stage, { clientX: 20, clientY: 20, pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerUp(stage, { clientX: 20, clientY: 20, pointerId: 1 });
    });

    expect(api.current.translateSelectedRegion).not.toHaveBeenCalled();
    expect(api.current.statuses).toContain("선택 영역이 너무 작습니다.");
    expect(api.current.getRegionSelection()).toBeNull();
  });

  it("does not start block dragging on a locked page", () => {
    const api = renderHarness({ selectedPageEditLocked: true });
    const block = screen.getByTestId("block");
    const stage = screen.getByTestId("stage");

    act(() => {
      fireEvent.pointerDown(block, { clientX: 20, clientY: 20, pointerId: 1 });
      fireEvent.pointerMove(stage, { clientX: 80, clientY: 80, pointerId: 1 });
    });

    expect(api.current.getSelectedBlockId()).toBeNull();
    expect(api.current.updateCurrentChapter).not.toHaveBeenCalled();
  });

  it("keeps block selection and blocks canvas editing while a job is active", () => {
    const api = renderHarness({
      initialSelectedBlockId: "block-1",
      jobActive: true,
    });
    const block = screen.getByTestId("block");
    const stage = screen.getByTestId("stage");

    act(() => {
      fireEvent.pointerDown(block, {
        clientX: 20,
        clientY: 20,
        pointerId: 1,
      });
      fireEvent.pointerMove(stage, {
        clientX: 80,
        clientY: 80,
        pointerId: 1,
      });
      fireEvent.pointerDown(stage, {
        clientX: 90,
        clientY: 90,
        pointerId: 2,
      });
    });

    expect(api.current.getSelectedBlockId()).toBe("block-1");
    expect(api.current.updateCurrentChapter).not.toHaveBeenCalled();
  });
});

function renderHarness(
  props: {
    initialSelectedBlockId?: string | null;
    jobActive?: boolean;
    renderOverlay?: boolean;
    regionTranslationReady?: boolean;
    selectedPageEditLocked?: boolean;
    stageTool?: StageTool;
    strictMode?: boolean;
  } = {},
): React.MutableRefObject<HarnessApi> {
  const api = React.createRef<HarnessApi>();

  const harness = (
    <WorkspacePointerHarness
      onReady={(nextApi) => {
        api.current = nextApi;
      }}
      initialSelectedBlockId={props.initialSelectedBlockId ?? null}
      jobActive={props.jobActive ?? false}
      renderOverlay={props.renderOverlay ?? false}
      regionTranslationReady={props.regionTranslationReady ?? true}
      selectedPageEditLocked={props.selectedPageEditLocked ?? false}
      stageTool={props.stageTool ?? "select"}
    />
  );
  render(
    props.strictMode ? <React.StrictMode>{harness}</React.StrictMode> : harness,
  );

  if (!api.current) {
    throw new Error("Workspace pointer harness did not initialize.");
  }
  return api as React.MutableRefObject<HarnessApi>;
}

function WorkspacePointerHarness({
  initialSelectedBlockId,
  jobActive,
  onReady,
  renderOverlay,
  regionTranslationReady,
  selectedPageEditLocked,
  stageTool,
}: {
  initialSelectedBlockId: string | null;
  jobActive: boolean;
  onReady: (api: HarnessApi) => void;
  renderOverlay: boolean;
  regionTranslationReady: boolean;
  selectedPageEditLocked: boolean;
  stageTool: StageTool;
}): React.JSX.Element {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  const selectedPageIdRef = useRef<string | null>("page-1");
  const inpaintingRetouchDrawingRef = useRef(false);
  const inpaintingRetouchPointsRef = useRef<Array<{ x: number; y: number }>>(
    [],
  );
  const lastInpaintingRetouchPointRef = useRef<{ x: number; y: number } | null>(
    null,
  );
  const [regionSelection, setRegionSelection] =
    useState<RegionSelectionState | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(
    initialSelectedBlockId,
  );
  const [selectedBlockIds, setSelectedBlockIds] = useState<string[]>([]);
  const [, setInpaintingPaintColor] = useState("#ffffff");
  const [, setInpaintingTool] = useState<InpaintingTool>("none");
  const [patternMaskStrokesByPage, setPatternMaskStrokesByPage] = useState<
    Record<string, InpaintingMaskStroke[]>
  >({});
  const statusesRef = useRef<string[]>([]);
  const updateCurrentChapter = useMemo(createUpdateCurrentChapterMock, []);
  const translateSelectedRegion = useMemo(
    createTranslateSelectedRegionMock,
    [],
  );
  const getBounds = useMemo(() => vi.fn(() => makeDomRect()), []);
  const page = makePage();
  const block = page.blocks[0];
  const handlers = useWorkspacePointerHandlers({
    appendRetouchPoint: () => null,
    applyRetouchOperation: async () => undefined,
    currentChapter: makeChapter(page),
    imageRef,
    inpaintingBrushRadius: 28,
    inpaintingPaintColor: "#ffffff",
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    inpaintingTool: "none",
    inpaintingToolActive: false,
    jobActive,
    lastInpaintingRetouchPointRef,
    onPatternMaskChange: () => undefined,
    patternMaskStrokesByPage,
    pushStatus: (line) => {
      statusesRef.current.push(line);
    },
    regionTranslationReady,
    regionSelection,
    selectedPage: page,
    selectedPageEditLocked,
    selectedPageIdRef,
    selectedPageImagePath: "page-1.png",
    setInpaintingPaintColor,
    setInpaintingTool,
    setPatternMaskStrokesByPage,
    setRegionSelection,
    setSelectedBlockId,
    setSelectedBlockIds,
    stageRef,
    stageTool,
    translateSelectedRegion,
    updateCurrentChapter,
    workspacePanelRef,
  });

  useLayoutEffect(() => {
    if (stageRef.current) {
      stageRef.current.getBoundingClientRect = getBounds;
    }
    if (imageRef.current) {
      imageRef.current.getBoundingClientRect = getBounds;
    }
  }, [getBounds]);

  useEffect(() => {
    onReady({
      getBounds,
      getBlockCreateRect: handlers.interactionPreviewStore.getBlockCreateRect,
      getBlockPreview: () =>
        handlers.interactionPreviewStore.getBlockPreview("block-1"),
      getRenderCount: () => renderCountRef.current,
      getRegionSelection: () => regionSelection,
      getRegionSelectionPreview:
        handlers.interactionPreviewStore.getRegionSelectionRect,
      getSelectedBlockId: () => selectedBlockId,
      startRegionTranslationSelection: handlers.startRegionTranslationSelection,
      statuses: statusesRef.current,
      translateSelectedRegion,
      updateCurrentChapter,
    });
  }, [
    handlers.startRegionTranslationSelection,
    handlers.interactionPreviewStore,
    getBounds,
    onReady,
    regionSelection,
    selectedBlockId,
    translateSelectedRegion,
    updateCurrentChapter,
  ]);

  return (
    <section ref={workspacePanelRef}>
      {renderOverlay ? (
        <TestFontsProvider>
          <ImageStage
            blockPointerDisabled={false}
            imageDataUrl="data:image/png;base64,preview"
            imageRef={imageRef}
            interactionPreviewStore={handlers.interactionPreviewStore}
            onBlockPointerDown={handlers.onBlockPointerDown}
            onStagePointerDown={handlers.onStagePointerDown}
            onStagePointerLeave={handlers.onStagePointerLeave}
            onStagePointerMove={handlers.onStagePointerMove}
            onStagePointerUp={handlers.onStagePointerUp}
            page={page}
            regionSelectionActive={Boolean(regionSelection?.active)}
            regionSelectionRect={null}
            selectedBlockId={selectedBlockId}
            selectedBlockIds={selectedBlockIds}
            showBlockChrome
            showTextBlocks
            stageRef={stageRef}
            stageSize={{ height: 100, width: 100 }}
            stageTool="select"
            textLayoutStageSize={{ height: 100, width: 100 }}
          />
        </TestFontsProvider>
      ) : (
        <div
          data-testid="stage"
          onPointerDown={handlers.onStagePointerDown}
          onPointerMove={handlers.onStagePointerMove}
          onPointerUp={handlers.onStagePointerUp}
          ref={stageRef}
        >
          <img alt="" ref={imageRef} />
          {block ? (
            <button
              data-testid="block"
              onPointerDown={(event) =>
                handlers.onBlockPointerDown(event, block, "move")
              }
              type="button"
            >
              block
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function TestFontsProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <FontsContext.Provider value={fontsContext}>
      {children}
    </FontsContext.Provider>
  );
}

function createUpdateCurrentChapterMock() {
  return vi.fn(
    (
      pageId: string,
      updater: (chapter: ChapterSnapshot) => ChapterSnapshot,
    ) => {
      void pageId;
      void updater;
    },
  );
}

function createTranslateSelectedRegionMock() {
  return vi.fn(async (bbox: BBox) => {
    void bbox;
  });
}

function makeDomRect(): DOMRect {
  return {
    bottom: 100,
    height: 100,
    left: 0,
    right: 100,
    top: 0,
    width: 100,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  };
}

function installAnimationFrameController(): {
  count: () => number;
  flush: () => void;
} {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      callbacks.delete(id);
    }),
  );
  return {
    count: () => callbacks.size,
    flush: () => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(16.67);
    },
  };
}

function makeChapter(page: MangaPage): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [page],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page-1.png",
    imagePath: "page-1.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [makeBlock()],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 100 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 0.9,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}
