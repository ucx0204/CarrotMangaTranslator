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
import { BubbleLayoutContextBar } from "../src/renderer/src/components/BubbleLayoutContextBar";
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
import type { BubbleLayoutDraftPreview } from "../src/renderer/src/lib/workspaceInteractionPreview";

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
  applyBubbleLayoutDraft: () => boolean;
  getBounds: ReturnType<typeof vi.fn>;
  getBlockCreateRect: () => BBox | null;
  getBlockPreview: () => TranslationBlock | null;
  getBubbleLayoutDraft: () => BubbleLayoutDraftPreview | null;
  getRenderCount: () => number;
  getRegionSelection: () => RegionSelectionState | null;
  getRegionSelectionPreview: () => BBox | null;
  getSelectedBlockId: () => string | null;
  startRegionTranslationSelection: () => void;
  statuses: string[];
  onBubbleLayoutFinished: ReturnType<typeof vi.fn>;
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

  it("applies a point-authored bubble region as one undoable block edit", () => {
    const api = renderHarness({
      initialSelectedBlockId: "block-1",
      renderOverlay: true,
      stageTool: "bubble",
    });
    const stage = document.querySelector<HTMLElement>(".image-stage");
    expect(stage).not.toBeNull();
    const contextBar = screen.getByRole("region", {
      name: "말풍선 모양 편집",
    });
    expect(stage?.contains(contextBar)).toBe(false);
    expect(document.querySelector(".bubble-layout-draft-hud")).toBeNull();

    for (const [clientX, clientY] of [
      [20, 20],
      [80, 18],
      [84, 72],
      [24, 82],
    ]) {
      fireEvent.pointerDown(stage as HTMLElement, {
        button: 0,
        clientX,
        clientY,
        pointerId: 9,
      });
    }

    expect(
      document.querySelectorAll("[data-bubble-layout-point]"),
    ).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "적용" }));

    expect(api.current.updateCurrentChapter).toHaveBeenCalledTimes(1);
    expect(api.current.updateCurrentChapter.mock.calls[0]?.[2]).toMatchObject({
      label: "말풍선 모양 편집",
    });
    const updater = api.current.updateCurrentChapter.mock.calls[0]?.[1];
    const updated = updater?.(makeChapter(makePage()));
    const block = updated?.pages[0]?.blocks[0];
    expect(block?.renderDirection).toBe("horizontal");
    expect(block?.renderBboxSpace).toBe("normalized_1000");
    expect(block?.bubbleLayout).toMatchObject({
      direction: "horizontal",
      origin: "manual",
      modelId: "manual-shape-v1",
    });
    expect(block?.bubbleLayout).not.toHaveProperty("sourceImageRevision");
    expect(api.current.getBubbleLayoutDraft()).toBeNull();
  });

  it("sculpts an automatically detected bubble, supports undo, and commits manual provenance", () => {
    const api = renderHarness({
      initialSelectedBlockId: "block-1",
      renderOverlay: true,
      stageSize: { height: 180, width: 100 },
      stageTool: "bubble",
      withBubbleLayout: true,
    });
    const stage = document.querySelector<HTMLElement>(".image-stage");
    expect(stage).not.toBeNull();
    expect(
      document.querySelector(".overlay-block")?.classList.contains("selected"),
    ).toBe(false);
    expect(document.querySelector("[data-bubble-layout-guide]")).not.toBeNull();
    expect(document.querySelector(".overlay-resize-handle")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "+ 늘리기" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const radius = screen.getByLabelText("브러시") as HTMLInputElement;
    expect(radius.value).toBe("36");
    const renderCountBeforeDraftControls = api.current.getRenderCount();
    fireEvent.change(radius, { target: { value: "60" } });
    expect(api.current.getRenderCount()).toBe(renderCountBeforeDraftControls);

    drawBubbleBrush(stage as HTMLElement, [
      [28, 15],
      [38, 15],
    ]);
    expect(api.current.getRenderCount()).toBe(renderCountBeforeDraftControls);
    const brushCursor = document.querySelector<HTMLElement>(
      "[data-bubble-layout-brush-cursor]",
    );
    expect(brushCursor?.classList.contains("retouch-cursor")).toBe(true);
    expect(brushCursor?.style.width).toBe("12px");
    expect(brushCursor?.style.height).toBe("12px");
    expect(brushCursor?.style.getPropertyValue("--retouch-cursor-color")).toBe(
      "#78f2c5",
    );
    expect(brushCursor?.querySelector("span")).not.toBeNull();

    const expanded = api.current.getBubbleLayoutDraft();
    expect(expanded?.dirty).toBe(true);
    expect(expanded?.history).toHaveLength(1);
    expect(
      (expanded?.shape?.renderBbox.x ?? 0) +
        (expanded?.shape?.renderBbox.w ?? 0),
    ).toBeGreaterThan(300);

    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    const restored = api.current.getBubbleLayoutDraft();
    expect(restored?.dirty).toBe(false);
    expect(restored?.shape?.renderBbox).toEqual({
      x: 100,
      y: 100,
      w: 200,
      h: 100,
    });

    drawBubbleBrush(stage as HTMLElement, [
      [28, 15],
      [38, 15],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expectSculptedBubbleCommit(api.current);
  });

  it("shows a detached brush rejection without creating history or dirty state", () => {
    const api = renderHarness({
      initialSelectedBlockId: "block-1",
      renderOverlay: true,
      stageTool: "bubble",
      withBubbleLayout: true,
    });
    const stage = document.querySelector<HTMLElement>(".image-stage");

    drawBubbleBrush(stage as HTMLElement, [[80, 80]]);

    const draft = api.current.getBubbleLayoutDraft();
    expect(draft?.dirty).toBe(false);
    expect(draft?.history).toHaveLength(0);
    expect(draft?.notice).toBe("detached");
    expect(
      screen.getByText("현재 모양에 닿은 곳부터 늘려 주세요.").textContent,
    ).toBe("현재 모양에 닿은 곳부터 늘려 주세요.");
  });

  it("requires a fresh valid polygon after leaving sculpt mode", () => {
    const api = renderHarness({
      initialSelectedBlockId: "block-1",
      renderOverlay: true,
      stageTool: "bubble",
      withBubbleLayout: true,
    });
    const stage = document.querySelector<HTMLElement>(".image-stage");
    expect(stage).not.toBeNull();
    drawBubbleBrush(stage as HTMLElement, [
      [28, 15],
      [38, 15],
    ]);

    fireEvent.click(screen.getByRole("button", { name: "다각형" }));
    expect(api.current.getBubbleLayoutDraft()?.points).toHaveLength(0);
    for (const clientX of [20, 40, 60]) {
      fireEvent.pointerDown(stage as HTMLElement, {
        button: 0,
        clientX,
        clientY: 20,
        pointerId: 20,
      });
    }

    expect(
      (screen.getByRole("button", { name: "적용" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(api.current.updateCurrentChapter).not.toHaveBeenCalled();
  });

  it("cancels bubble sculpting without a chapter write and exits the tool", () => {
    const api = renderHarness({
      initialSelectedBlockId: "block-1",
      renderOverlay: true,
      stageTool: "bubble",
      withBubbleLayout: true,
    });
    const stage = document.querySelector<HTMLElement>(".image-stage");
    drawBubbleBrush(stage as HTMLElement, [
      [28, 15],
      [38, 15],
    ]);

    fireEvent.click(screen.getByRole("button", { name: "취소" }));

    expect(api.current.getBubbleLayoutDraft()).toBeNull();
    expect(api.current.updateCurrentChapter).not.toHaveBeenCalled();
    expect(api.current.onBubbleLayoutFinished).toHaveBeenCalledTimes(1);
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
    stageSize?: { height: number; width: number };
    stageTool?: StageTool;
    strictMode?: boolean;
    withBubbleLayout?: boolean;
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
      stageSize={props.stageSize ?? { height: 100, width: 100 }}
      stageTool={props.stageTool ?? "select"}
      withBubbleLayout={props.withBubbleLayout ?? false}
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
  stageSize,
  stageTool,
  withBubbleLayout,
}: {
  initialSelectedBlockId: string | null;
  jobActive: boolean;
  onReady: (api: HarnessApi) => void;
  renderOverlay: boolean;
  regionTranslationReady: boolean;
  selectedPageEditLocked: boolean;
  stageSize: { height: number; width: number };
  stageTool: StageTool;
  withBubbleLayout: boolean;
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
  const onBubbleLayoutFinished = useMemo(() => vi.fn(), []);
  const translateSelectedRegion = useMemo(
    createTranslateSelectedRegionMock,
    [],
  );
  const getBounds = useMemo(() => vi.fn(() => makeDomRect()), []);
  const page = makePage({ withBubbleLayout });
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
    onBubbleLayoutApplied: onBubbleLayoutFinished,
    patternMaskStrokesByPage,
    pushStatus: (line) => {
      statusesRef.current.push(line);
    },
    regionTranslationReady,
    regionSelection,
    selectedPage: page,
    selectedBlockId,
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
      applyBubbleLayoutDraft: handlers.applyBubbleLayoutDraft,
      getBounds,
      getBlockCreateRect: handlers.interactionPreviewStore.getBlockCreateRect,
      getBlockPreview: () =>
        handlers.interactionPreviewStore.getBlockPreview("block-1"),
      getBubbleLayoutDraft:
        handlers.interactionPreviewStore.getBubbleLayoutDraft,
      getRenderCount: () => renderCountRef.current,
      getRegionSelection: () => regionSelection,
      getRegionSelectionPreview:
        handlers.interactionPreviewStore.getRegionSelectionRect,
      getSelectedBlockId: () => selectedBlockId,
      onBubbleLayoutFinished,
      startRegionTranslationSelection: handlers.startRegionTranslationSelection,
      statuses: statusesRef.current,
      translateSelectedRegion,
      updateCurrentChapter,
    });
  }, [
    handlers.startRegionTranslationSelection,
    handlers.interactionPreviewStore,
    getBounds,
    onBubbleLayoutFinished,
    onReady,
    regionSelection,
    selectedBlockId,
    translateSelectedRegion,
    updateCurrentChapter,
  ]);

  return (
    <section ref={workspacePanelRef}>
      {renderOverlay ? (
        <>
          <BubbleLayoutContextBar
            interactionPreviewStore={handlers.interactionPreviewStore}
            onApply={handlers.applyBubbleLayoutDraft}
            onCancel={handlers.cancelBubbleLayoutDraft}
            onUndoPoint={handlers.undoBubbleLayoutPoint}
          />
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
              stageSize={stageSize}
              stageTool={stageTool}
              textLayoutStageSize={stageSize}
            />
          </TestFontsProvider>
        </>
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
      options?: { label?: string },
    ) => {
      void pageId;
      void updater;
      void options;
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

function makePage({
  withBubbleLayout = false,
}: {
  withBubbleLayout?: boolean;
} = {}): MangaPage {
  return {
    id: "page-1",
    name: "page-1.png",
    imagePath: "page-1.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [makeBlock(withBubbleLayout)],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(withBubbleLayout = false): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 100 },
    sourceText: "source",
    translatedText: "translated",
    confidence: 0.9,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    renderBbox: withBubbleLayout
      ? { x: 100, y: 100, w: 200, h: 100 }
      : undefined,
    renderBboxSpace: withBubbleLayout ? "normalized_1000" : undefined,
    bubbleLayout: withBubbleLayout
      ? {
          version: 1,
          direction: "horizontal",
          confidence: 0.97,
          origin: "detected",
          modelId: "comic-rtdetr-v1",
          sourceImageRevision: "revision-1",
          insetRatio: 0,
          regions: [
            {
              spans: [
                {
                  blockStart: 0,
                  blockEnd: 1,
                  inlineStart: 0,
                  inlineEnd: 1,
                },
              ],
            },
          ],
        }
      : undefined,
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
    wordBreak: "keep-all",
  };
}

function drawBubbleBrush(
  stage: HTMLElement,
  points: Array<[number, number]>,
): void {
  const [first, ...rest] = points;
  if (!first) return;
  fireEvent.pointerDown(stage, {
    button: 0,
    clientX: first[0],
    clientY: first[1],
    pointerId: 19,
  });
  for (const [clientX, clientY] of rest) {
    fireEvent.pointerMove(stage, { clientX, clientY, pointerId: 19 });
  }
  const last = points.at(-1) ?? first;
  fireEvent.pointerUp(stage, {
    clientX: last[0],
    clientY: last[1],
    pointerId: 19,
  });
}

function expectSculptedBubbleCommit(api: HarnessApi): void {
  const updater = api.updateCurrentChapter.mock.calls[0]?.[1];
  const updated = updater?.(makeChapter(makePage({ withBubbleLayout: true })));
  const block = updated?.pages[0]?.blocks[0];
  expect(block?.bubbleLayout).toMatchObject({
    direction: "horizontal",
    origin: "manual",
    modelId: "manual-sculpt-v1",
  });
  expect(block?.bubbleLayout).not.toHaveProperty("sourceImageRevision");
  expect(block?.renderDirection).toBe("horizontal");
  expect(block?.wordBreak).toBe("keep-all");
  expect(api.onBubbleLayoutFinished).toHaveBeenCalledTimes(1);
}
