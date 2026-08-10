import { describe, expect, it, vi } from "vitest";
import { createRightRailProps } from "../src/renderer/src/app/session/createRightRailProps";

describe("right rail block selection routing", () => {
  it("keeps page-list text focus in the page block panel and reserves the full editor for details", () => {
    const setRightRailMode = vi.fn();
    const setSelectedBlockId = vi.fn();
    const setSelectedBlockIds = vi.fn();
    const selectedBlockIdRef = { current: null as string | null };
    const noop = vi.fn();
    const model = {
      blockEditingActions: { updateBlock: noop },
      bridgeActions: { cancelJob: noop, openLogFolder: noop },
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
      statusLog: { clearStatusLines: noop, statusLines: [] },
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
        setTextViewOpen: noop,
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
  });
});
