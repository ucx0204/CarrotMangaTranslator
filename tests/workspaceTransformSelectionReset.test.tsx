/** @vitest-environment jsdom */

import React, { useCallback, useMemo, useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { ImageStage } from "../src/renderer/src/components/ImageStage";
import {
  FontsContext,
  type FontsContextValue,
} from "../src/renderer/src/fonts/fontsContextValue";
import { DEFAULT_BLOCK_FONT_CATALOG } from "../src/renderer/src/lib/fonts";
import type { StageTool } from "../src/renderer/src/lib/stageTool";
import type { UpdateCurrentChapter } from "../src/renderer/src/hooks/useCurrentChapterUpdater";
import { useWorkspacePointerHandlers } from "../src/renderer/src/hooks/useWorkspacePointerHandlers";

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

beforeAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      font: "",
      measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
    }),
  });
});

afterEach(() => cleanup());

afterAll(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: originalGetContext,
  });
});

describe("workspace transform mode selection changes", () => {
  it.each(["curve", "perspective"] as const)(
    "switches %s mode to select and shows normal handles on a different block",
    (initialTool) => {
      const { container } = render(
        <WorkspaceSelectionHarness initialTool={initialTool} />,
      );

      expect(
        container.querySelector(`.${initialTool}-controls`),
      ).not.toBeNull();

      const blocks = container.querySelectorAll<HTMLElement>(".overlay-block");
      fireEvent.pointerDown(blocks[1] as HTMLElement, {
        button: 0,
        clientX: 70,
        clientY: 20,
        pointerId: 7,
      });

      const updatedBlocks =
        container.querySelectorAll<HTMLElement>(".overlay-block");
      expect(screen.getByTestId("stage-tool").textContent).toBe("select");
      expect(updatedBlocks[0]?.classList.contains("selected")).toBe(false);
      expect(updatedBlocks[1]?.classList.contains("selected")).toBe(true);
      expect(
        updatedBlocks[1]?.classList.contains("transform-mode-select"),
      ).toBe(true);
      expect(
        updatedBlocks[1]?.querySelectorAll("[data-transform-handle]"),
      ).toHaveLength(9);
      expect(
        container.querySelector(".curve-controls, .perspective-controls"),
      ).toBeNull();
    },
  );

  it("keeps curve mode while editing the already selected block", () => {
    const { container } = render(
      <WorkspaceSelectionHarness initialTool="curve" />,
    );
    const curveControl = container.querySelector<HTMLElement>(
      '[data-transform-handle="curve-control"]',
    );
    expect(curveControl).not.toBeNull();

    fireEvent.pointerDown(curveControl as HTMLElement, {
      button: 0,
      clientX: 25,
      clientY: 15,
      pointerId: 8,
    });

    expect(screen.getByTestId("stage-tool").textContent).toBe("curve");
    expect(screen.getByTestId("right-rail-mode").textContent).toBe(
      "block-editor",
    );
    expect(container.querySelector(".curve-controls")).not.toBeNull();
  });

  it("preserves Ctrl multi-selection when a different block resets curve mode", () => {
    const { container } = render(
      <WorkspaceSelectionHarness initialTool="curve" />,
    );
    const blocks = container.querySelectorAll<HTMLElement>(".overlay-block");

    fireEvent.pointerDown(blocks[1] as HTMLElement, {
      button: 0,
      clientX: 70,
      clientY: 20,
      ctrlKey: true,
      pointerId: 9,
    });

    const updatedBlocks =
      container.querySelectorAll<HTMLElement>(".overlay-block");
    expect(screen.getByTestId("stage-tool").textContent).toBe("select");
    expect(screen.getByTestId("selected-block-ids").textContent).toBe(
      "block-a,block-b",
    );
    expect(updatedBlocks[0]?.classList.contains("multi-selected")).toBe(true);
    expect(updatedBlocks[1]?.classList.contains("multi-selected")).toBe(true);
    expect(updatedBlocks[1]?.classList.contains("selected")).toBe(true);
  });
});

function WorkspaceSelectionHarness({
  initialTool,
}: {
  initialTool: Extract<StageTool, "curve" | "perspective">;
}): React.JSX.Element {
  const page = useMemo(makePage, []);
  const chapter = useMemo(() => makeChapter(page), [page]);
  const model = useSelectionHarnessModel(initialTool, page, chapter);

  return (
    <FontsContext.Provider value={fontsContext}>
      <output data-testid="stage-tool">{model.stageTool}</output>
      <output data-testid="right-rail-mode">{model.rightRailMode}</output>
      <output data-testid="selected-block-ids">
        {model.selectedBlockIds.join(",")}
      </output>
      <ImageStage
        blockPointerDisabled={false}
        imageDataUrl="data:image/png;base64,preview"
        imageRef={model.refs.imageRef}
        interactionPreviewStore={model.handlers.interactionPreviewStore}
        onBlockPointerDown={model.handlers.onBlockPointerDown}
        onStagePointerDown={model.handlers.onStagePointerDown}
        onStagePointerLeave={model.handlers.onStagePointerLeave}
        onStagePointerMove={model.handlers.onStagePointerMove}
        onStagePointerUp={model.handlers.onStagePointerUp}
        page={page}
        regionSelectionActive={false}
        regionSelectionRect={null}
        selectedBlockId={model.selectedBlockId}
        selectedBlockIds={model.selectedBlockIds}
        showBlockChrome
        showTextBlocks
        stageRef={model.refs.stageRef}
        stageSize={{ height: 100, width: 100 }}
        stageTool={model.stageTool}
        textLayoutStageSize={{ height: 100, width: 100 }}
      />
    </FontsContext.Provider>
  );
}

function useSelectionHarnessModel(
  initialTool: Extract<StageTool, "curve" | "perspective">,
  page: MangaPage,
  chapter: ChapterSnapshot,
) {
  const refs = useHarnessRefs();
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(
    "block-a",
  );
  const [selectedBlockIds, setSelectedBlockIds] = useState(["block-a"]);
  const [stageTool, setStageTool] = useState<StageTool>(initialTool);
  const [rightRailMode, setRightRailMode] = useState("page-blocks");
  const updateCurrentChapter = useCallback<UpdateCurrentChapter>(
    () => undefined,
    [],
  );
  const resetTransformMode = useCallback(() => {
    setStageTool((current) =>
      current === "curve" || current === "perspective" ? "select" : current,
    );
  }, []);
  const handlers = useWorkspacePointerHandlers({
    appendRetouchPoint: () => null,
    applyRetouchOperation: async () => undefined,
    currentChapter: chapter,
    imageRef: refs.imageRef,
    inpaintingBrushRadius: 28,
    inpaintingPaintColor: "#ffffff",
    inpaintingRetouchDrawingRef: refs.inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef: refs.inpaintingRetouchPointsRef,
    inpaintingTool: "none",
    inpaintingToolActive: false,
    jobActive: false,
    lastInpaintingRetouchPointRef: refs.lastInpaintingRetouchPointRef,
    onPatternMaskChange: () => undefined,
    onBlockActivated: () => setRightRailMode("block-editor"),
    onSelectedBlockChange: resetTransformMode,
    patternMaskStrokesByPage: {},
    pushStatus: () => undefined,
    regionSelection: null,
    regionTranslationReady: true,
    selectedBlockId,
    selectedPage: page,
    selectedPageEditLocked: false,
    selectedPageIdRef: refs.selectedPageIdRef,
    selectedPageImagePath: "page-1.png",
    setInpaintingPaintColor: () => undefined,
    setInpaintingTool: () => undefined,
    setPatternMaskStrokesByPage: () => undefined,
    setRegionSelection: () => undefined,
    setSelectedBlockId,
    setSelectedBlockIds,
    stageRef: refs.stageRef,
    stageTool,
    translateSelectedRegion: async () => undefined,
    updateCurrentChapter,
    workspacePanelRef: refs.workspacePanelRef,
  });
  return {
    handlers,
    refs,
    selectedBlockId,
    selectedBlockIds,
    rightRailMode,
    stageTool,
  };
}

function useHarnessRefs() {
  return {
    imageRef: useRef<HTMLImageElement | null>(null),
    inpaintingRetouchDrawingRef: useRef(false),
    inpaintingRetouchPointsRef: useRef<Array<{ x: number; y: number }>>([]),
    lastInpaintingRetouchPointRef: useRef<{
      x: number;
      y: number;
    } | null>(null),
    selectedPageIdRef: useRef<string | null>("page-1"),
    stageRef: useRef<HTMLDivElement | null>(null),
    workspacePanelRef: useRef<HTMLElement | null>(null),
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
    blocks: [
      makeBlock("block-a", 100, makeCurveLayout()),
      makeBlock("block-b", 600),
    ],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeBlock(
  id: string,
  x: number,
  curveLayout?: NonNullable<TranslationBlock["curveLayout"]>,
): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x, y: 100, w: 260, h: 180 },
    sourceText: id,
    translatedText: id,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    curveLayout,
    fontSizePx: 28,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    outlineColor: "#ffffff",
    backgroundColor: "#ffffff",
    opacity: 1,
    autoFitText: false,
  };
}

function makeCurveLayout(): NonNullable<TranslationBlock["curveLayout"]> {
  return {
    version: 1,
    path: {
      type: "quadratic",
      start: { x: 0.05, y: 0.65 },
      control: { x: 0.5, y: 0.1 },
      end: { x: 0.95, y: 0.65 },
    },
    alignment: "center",
    offsetEm: 0,
    orientation: "tangent",
  };
}
