// @vitest-environment jsdom

import React, {
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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BBox, TranslationBlock } from "../src/shared/textTypes";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { useWorkspacePointerHandlers } from "../src/renderer/src/hooks/useWorkspacePointerHandlers";
import type { RetouchPreviewState } from "../src/renderer/src/hooks/useInpaintingRetouch";
import type { InpaintingTool } from "../src/renderer/src/inpainting/inpaintingTypes";
import type { RegionSelectionState } from "../src/renderer/src/lib/appHelpers";

type UpdateCurrentChapterMock = ReturnType<
  typeof createUpdateCurrentChapterMock
>;
type TranslateSelectedRegionMock = ReturnType<
  typeof createTranslateSelectedRegionMock
>;

type HarnessApi = {
  getRegionSelection: () => RegionSelectionState | null;
  getSelectedBlockId: () => string | null;
  startRegionTranslationSelection: () => void;
  statuses: string[];
  translateSelectedRegion: TranslateSelectedRegionMock;
  updateCurrentChapter: UpdateCurrentChapterMock;
};

afterEach(() => {
  cleanup();
});

describe("workspace pointer interactions", () => {
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
});

function renderHarness(
  props: { selectedPageEditLocked?: boolean } = {},
): React.MutableRefObject<HarnessApi> {
  const api = React.createRef<HarnessApi>();

  render(
    <WorkspacePointerHarness
      onReady={(nextApi) => {
        api.current = nextApi;
      }}
      selectedPageEditLocked={props.selectedPageEditLocked ?? false}
    />,
  );

  if (!api.current) {
    throw new Error("Workspace pointer harness did not initialize.");
  }
  return api as React.MutableRefObject<HarnessApi>;
}

function WorkspacePointerHarness({
  onReady,
  selectedPageEditLocked,
}: {
  onReady: (api: HarnessApi) => void;
  selectedPageEditLocked: boolean;
}): React.JSX.Element {
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
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [, setSelectedBlockIds] = useState<string[]>([]);
  const [, setRetouchCursorPoint] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [, setRetouchPreview] = useState<RetouchPreviewState | null>(null);
  const [, setInpaintingPaintColor] = useState("#ffffff");
  const [, setInpaintingTool] = useState<InpaintingTool>("none");
  const [, setPatternMaskStrokesByPage] = useState<
    Record<string, InpaintingMaskStroke[]>
  >({});
  const statusesRef = useRef<string[]>([]);
  const updateCurrentChapter = useMemo(createUpdateCurrentChapterMock, []);
  const translateSelectedRegion = useMemo(
    createTranslateSelectedRegionMock,
    [],
  );
  const page = makePage();
  const block = page.blocks[0];
  const handlers = useWorkspacePointerHandlers({
    appendRetouchPoint: () => undefined,
    applyRetouchPoints: async () => undefined,
    currentChapter: makeChapter(page),
    imageRef,
    inpaintingBrushRadius: 28,
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    inpaintingTool: "none",
    inpaintingToolActive: false,
    jobActive: false,
    lastInpaintingRetouchPointRef,
    pushStatus: (line) => {
      statusesRef.current.push(line);
    },
    regionSelection,
    selectedPage: page,
    selectedPageEditLocked,
    selectedPageIdRef,
    selectedPageImageDataUrl: "data:image/png;base64,page",
    selectedPageImagePath: "page-1.png",
    setInpaintingPaintColor,
    setInpaintingTool,
    setPatternMaskStrokesByPage,
    setRegionSelection,
    setRetouchCursorPoint,
    setRetouchPreview,
    setSelectedBlockId,
    setSelectedBlockIds,
    stageRef,
    stageTool: "select",
    translateSelectedRegion,
    updateCurrentChapter,
    workspacePanelRef,
  });

  useLayoutEffect(() => {
    const rect = makeDomRect();
    if (stageRef.current) {
      stageRef.current.getBoundingClientRect = () => rect;
    }
    if (imageRef.current) {
      imageRef.current.getBoundingClientRect = () => rect;
    }
  }, []);

  useEffect(() => {
    onReady({
      getRegionSelection: () => regionSelection,
      getSelectedBlockId: () => selectedBlockId,
      startRegionTranslationSelection: handlers.startRegionTranslationSelection,
      statuses: statusesRef.current,
      translateSelectedRegion,
      updateCurrentChapter,
    });
  }, [
    handlers.startRegionTranslationSelection,
    onReady,
    regionSelection,
    selectedBlockId,
    translateSelectedRegion,
    updateCurrentChapter,
  ]);

  return (
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
