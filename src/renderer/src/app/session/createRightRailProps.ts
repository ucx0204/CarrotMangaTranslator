import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";
import type { AutoInpaintingEntryScope } from "../../lib/autoInpaintingSelection";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";

type RightRailProps = AppSessionViewProps["rightRailProps"];

export function createRightRailProps(
  model: AppSessionViewModel,
): RightRailProps {
  const {
    bridgeActions,
    core,
    derivedState,
    inpaintingBridge,
    settingsDialog,
    statusLog,
    uiState,
    workspaceHistory,
  } = model;
  const inpainting = inpaintingBridge.contextValue;
  return {
    ...createRightRailActions(model),
    blockReadingDirection: resolveSourceReadingDirection(
      settingsDialog.settings?.translation?.sourceLanguage,
    ),
    brushColor: inpainting.brushColor,
    brushRadius: inpainting.brushRadius,
    canRedo: workspaceHistory.canRedo,
    canRunBubbleLayout: Boolean(
      derivedState.selectedPage?.inpaintedImagePath &&
      derivedState.selectedPage.blocks.length,
    ),
    canUndo: workspaceHistory.canUndo,
    compareAvailable: derivedState.peekAvailable,
    currentChapter: core.currentChapter,
    editorDisabled:
      derivedState.selectedPageEditLocked ||
      inpainting.jobActive ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    flowActive: uiState.translationFlowActive,
    jobActive:
      inpainting.jobActive ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    jobState: core.jobState,
    maskStrokeCount: inpainting.maskStrokeCount,
    peeking: derivedState.showingOriginalPeek,
    progressSnapshot: derivedState.progressSnapshot,
    redoLabel: workspaceHistory.redoLabel,
    resetAvailable: Boolean(derivedState.selectedPage?.inpaintedImagePath),
    rightRailMode: uiState.rightRailMode,
    selectedBlock: derivedState.selectedBlock,
    selectedBlockId: core.selectedBlockId,
    selectedPage: derivedState.selectedPage,
    showBlockChrome: uiState.showBlockChrome,
    showProgressBar: derivedState.showProgressBar,
    showTextBlocks: uiState.showTextBlocks,
    stageTool: uiState.stageTool,
    statusLines: statusLog.statusLines,
    undoLabel: workspaceHistory.undoLabel,
    onCancelJob: bridgeActions.cancelJob,
    onClearStatusLines: statusLog.clearStatusLines,
  };
}

function createRightRailActions({
  blockEditingActions,
  core,
  inpaintingActions,
  inpaintingBridge,
  uiState,
  workspaceHistory,
}: AppSessionViewModel) {
  const inpainting = inpaintingBridge.contextValue;
  const selectBlock = (blockId: string): void => {
    core.selectedBlockIdRef.current = blockId;
    core.setSelectedBlockId(blockId);
    core.setSelectedBlockIds([blockId]);
  };
  return {
    onBrushColorChange: inpainting.onBrushColorChange,
    onBrushRadiusChange: inpainting.onBrushRadiusChange,
    onClearPatternMask: inpainting.onClearPatternMask,
    onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => {
      prepareAutoInpainting(core, uiState, scope);
    },
    onOpenBlockEditor: (blockId: string) => {
      selectBlock(blockId);
      uiState.setRightRailMode("block-editor");
    },
    onOpenExport: () => uiState.setExportOptionsOpen(true),
    onOpenStyleGuide: () => uiState.setStyleGuideOpen(true),
    onOpenTextView: () => uiState.setTextViewOpen(true),
    onOpenTranslateOptions: () => uiState.openTranslateOptions(),
    onPeekToggle: inpainting.onPeekToggle,
    onRedo: () => void workspaceHistory.redo(),
    onResetPage: () => {
      uiState.setPeekOriginal(false);
      void inpaintingActions.revertInpainting("page");
    },
    onRunBubbleLayout: () => void inpaintingActions.runBubbleLayout(),
    onRunCurrentPageInpainting: () => {
      prepareAutoInpainting(core, uiState, "current");
    },
    onRunDrawnPattern: inpainting.onRunDrawnPattern,
    onSelectBlock: selectBlock,
    onToggleBlocks: () => uiState.setShowTextBlocks((visible) => !visible),
    onToggleChrome: () => uiState.setShowBlockChrome((visible) => !visible),
    onUndo: () => void workspaceHistory.undo(),
    onUpdateBlock: blockEditingActions.updateBlock,
  };
}

function prepareAutoInpainting(
  core: AppSessionViewModel["core"],
  uiState: AppSessionViewModel["uiState"],
  scope: AutoInpaintingEntryScope,
): void {
  core.setRegionSelection(null);
  uiState.selectWorkspaceTool("select");
  uiState.setPeekOriginal(false);
  uiState.setAutoInpaintingEntryScope(scope);
  uiState.setAutoInpaintingOptionsOpen(true);
}
