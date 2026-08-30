import { describe, expect, it, vi } from "vitest";
import { createRightRailProps } from "../src/renderer/src/app/session/createRightRailProps";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";
import type { LinkedWorkspaceStatus } from "../src/shared/linkedWorkspaceTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("right rail block selection routing", () => {
  it("keeps page-list text focus in the page block panel and reserves the full editor for details", () => {
    const setRightRailMode = vi.fn();
    const setSelectedBlockId = vi.fn();
    const setSelectedBlockIds = vi.fn();
    const selectedBlockIdRef = { current: null as string | null };
    const noop = vi.fn();
    const model = {
      blockEditingActions: { updateBlock: noop },
      bridgeActions: { cancelJob: noop },
      completionSound: {
        muted: true,
        volume: 0.55,
        translationMuted: false,
        sourceErasingMuted: false,
        researchMuted: false,
        setPreferences: noop,
      },
      core: {
        currentChapter: null,
        jobState: {
          id: "idle",
          kind: "gemma-analysis",
          progressText: "",
          status: "idle",
        },
        selectedBlockId: null,
        selectedBlockIdRef,
        setRegionSelection: noop,
        setSelectedBlockId,
        setSelectedBlockIds,
      },
      derivedState: {
        peekAvailable: false,
        progressSnapshot: null,
        selectedBlock: null,
        selectedPage: null,
        selectedPageEditLocked: false,
        showingOriginalPeek: false,
        showProgressBar: false,
      },
      inpaintingActions: {
        revertInpainting: noop,
        runBubbleLayout: noop,
      },
      inpaintingBridge: {
        contextValue: {
          brushColor: "#ffffff",
          brushRadius: 28,
          jobActive: false,
          maskStrokeCount: 0,
          onBrushColorChange: noop,
          onBrushRadiusChange: noop,
          onClearPatternMask: noop,
          onPeekToggle: noop,
          onRunDrawnPattern: noop,
        },
      },
      persistence: { saveNow: noop, saveStatus: "idle" },
      retranslatePage: noop,
      settingsDialog: { settings: null },
      statusLog: {
        clearStatusLines: noop,
        statusEntries: [],
        statusLines: [],
      },
      uiState: {
        openTranslateOptions: noop,
        rightRailMode: "block-editor",
        selectWorkspaceTool: noop,
        setAutoInpaintingEntryScope: noop,
        setAutoInpaintingOptionsOpen: noop,
        setExportOptionsOpen: noop,
        setPeekOriginal: noop,
        setRightRailMode,
        setShowBlockChrome: noop,
        setShowTextBlocks: noop,
        setStyleGuideOpen: noop,
        openTextView: noop,
        showBlockChrome: true,
        showTextBlocks: true,
        stageTool: "select",
        translationFlowActive: false,
      },
      workspaceHistory: {
        busy: false,
        canRedo: false,
        canUndo: false,
        redo: noop,
        redoLabel: null,
        undo: noop,
        undoLabel: null,
      },
    } satisfies Parameters<typeof createRightRailProps>[0];

    const props = createRightRailProps(model);

    const cancelOperation = vi.fn(async () => undefined);
    const operationProps = createRightRailProps({
      ...model,
      operationActivity: {
        activity: {
          id: "import-1",
          kind: "library-import",
          status: "running",
          phase: "import-library-writing",
          sourceKind: "pdf",
          mutatesLibrary: true,
          cancellable: true,
          startedAt: 1,
          updatedAt: 1,
        },
        active: true,
        libraryMutationBlocked: true,
        cancel: cancelOperation,
        clearTerminal: noop,
      },
    });
    expect(operationProps.exclusiveActivityActive).toBe(true);
    expect(operationProps.jobActive).toBe(false);
    expect(operationProps.editorDisabled).toBe(false);
    operationProps.onCancelOperation?.();
    expect(cancelOperation).toHaveBeenCalledOnce();

    props.onSelectBlock("block-from-translation");
    expect(selectedBlockIdRef.current).toBe("block-from-translation");
    expect(setSelectedBlockId).toHaveBeenCalledWith("block-from-translation");
    expect(setSelectedBlockIds).toHaveBeenCalledWith([
      "block-from-translation",
    ]);
    expect(setRightRailMode).toHaveBeenLastCalledWith("page-blocks");

    setRightRailMode.mockClear();
    props.onOpenBlockEditor("block-from-details");
    expect(setRightRailMode).toHaveBeenCalledOnce();
    expect(setRightRailMode).toHaveBeenCalledWith("block-editor");

    const viewResults = vi.fn();
    const openExportOptions = vi.fn();
    const moveSelectedBlockInReadingOrder = vi.fn();
    const sortPageReadingOrder = vi.fn();
    const onAdjustPatternMask = vi.fn();
    const activeBlock: TranslationBlock = {
      id: "block-1",
      type: "nonsolid",
      bbox: { x: 100, y: 100, w: 200, h: 200 },
      sourceText: "source",
      translatedText: "translation",
      confidence: 1,
      sourceDirection: "horizontal",
      renderDirection: "horizontal",
      fontSizePx: 24,
      lineHeight: 1.18,
      textAlign: "center",
      textColor: "#111111",
      backgroundColor: "#ffffff",
      opacity: 1,
    };
    const activePage: MangaPage = {
      id: "page-1",
      name: "page-1.png",
      imagePath: "page-1.png",
      inpaintedImagePath: "inpainted.png",
      dataUrl: "data:image/png;base64,",
      width: 1000,
      height: 1400,
      blocks: [activeBlock],
      analysisStatus: "completed",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const activeChapter: ChapterSnapshot = {
      id: "chapter-1",
      workId: "work-1",
      title: "Chapter 1",
      sourceKind: "images",
      status: "completed",
      pageOrder: [activePage.id],
      pages: [activePage],
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const activeLibrary: LibraryIndex = {
      workOrder: ["work-1"],
      works: [
        {
          id: "work-1",
          title: "Work 1",
          chapterOrder: [activeChapter.id],
          readingDirection: "rtl",
          chapters: [
            {
              id: activeChapter.id,
              workId: activeChapter.workId,
              title: activeChapter.title,
              status: activeChapter.status,
              pageCount: 1,
              createdAt: activeChapter.createdAt,
              updatedAt: activeChapter.updatedAt,
            },
          ],
          createdAt: "2026-08-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
        },
      ],
    };
    const linkedWorkspaceStatus: LinkedWorkspaceStatus = {
      chapterId: activeChapter.id,
      state: "idle",
      pendingCount: 0,
      failedCount: 0,
    };
    const activeModel = {
      ...model,
      blockEditingActions: {
        ...model.blockEditingActions,
        moveSelectedBlockInReadingOrder,
        sortPageReadingOrder,
      },
      core: {
        ...model.core,
        currentChapter: activeChapter,
        library: activeLibrary,
        selectedBlockIds: ["selected-1", "selected-2"],
      },
      derivedState: {
        ...model.derivedState,
        selectedPage: activePage,
        selectedPageEditLocked: true,
      },
      inpaintingBridge: {
        contextValue: {
          ...model.inpaintingBridge.contextValue,
          jobActive: true,
          onAdjustPatternMask,
        },
      },
      linkedWorkspace: {
        status: linkedWorkspaceStatus,
        viewBusy: true,
        viewResults,
      },
      uiState: {
        ...model.uiState,
        openExportOptions,
        translationFlowActive: true,
      },
      workspaceHistory: {
        ...model.workspaceHistory,
        busy: true,
      },
    } satisfies Parameters<typeof createRightRailProps>[0];

    const activeProps = createRightRailProps(activeModel);
    expect(activeProps.blockReadingDirection).toBe("rtl");
    expect(activeProps.canRunBubbleLayout).toBe(true);
    expect(activeProps.editorDisabled).toBe(true);
    expect(activeProps.jobActive).toBe(true);
    expect(activeProps.linkedWorkspaceStatus).toBe(linkedWorkspaceStatus);
    expect(activeProps.linkedWorkspaceViewBusy).toBe(true);
    expect(activeProps.selectedBlockIds).toEqual(["selected-1", "selected-2"]);
    expect(activeProps.onAdjustPatternMask).toBe(onAdjustPatternMask);

    activeProps.onViewLinkedResults?.();
    expect(viewResults).toHaveBeenCalledOnce();

    activeProps.onOpenExport();
    activeProps.onOpenPsdExport?.();
    expect(openExportOptions).toHaveBeenNthCalledWith(1, "raster");
    expect(openExportOptions).toHaveBeenNthCalledWith(2, "psd");

    activeProps.onMoveBlockInReadingOrder?.("move-me", -1);
    expect(moveSelectedBlockInReadingOrder).toHaveBeenCalledWith(-1, "move-me");
    activeProps.onSortReadingOrder?.();
    expect(sortPageReadingOrder).toHaveBeenCalledOnce();
  });
});
