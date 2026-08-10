import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";
import type { AutoInpaintingEntryScope } from "../../lib/autoInpaintingSelection";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";

type RightRailProps = AppSessionViewProps["rightRailProps"];
type RightRailViewModel = {
  blockEditingActions: Pick<
    AppSessionViewModel["blockEditingActions"],
    "updateBlock"
  >;
  bridgeActions: Pick<
    AppSessionViewModel["bridgeActions"],
    "cancelJob" | "openLogFolder"
  >;
  core: Pick<
    AppSessionViewModel["core"],
    | "currentChapter"
    | "jobState"
    | "selectedBlockId"
    | "selectedBlockIdRef"
    | "setRegionSelection"
    | "setSelectedBlockId"
    | "setSelectedBlockIds"
  >;
  derivedState: Pick<
    AppSessionViewModel["derivedState"],
    | "peekAvailable"
    | "progressSnapshot"
    | "selectedBlock"
    | "selectedPage"
    | "selectedPageEditLocked"
    | "showingOriginalPeek"
    | "showProgressBar"
  >;
  inpaintingActions: Pick<
    AppSessionViewModel["inpaintingActions"],
    "revertInpainting" | "runBubbleLayout"
  >;
  inpaintingBridge: {
    contextValue: Pick<
      AppSessionViewModel["inpaintingBridge"]["contextValue"],
      | "brushColor"
      | "brushRadius"
      | "jobActive"
      | "maskStrokeCount"
      | "onBrushColorChange"
      | "onBrushRadiusChange"
      | "onClearPatternMask"
      | "onPeekToggle"
      | "onRunDrawnPattern"
    >;
  };
  persistence: Pick<
    AppSessionViewModel["persistence"],
    "saveNow" | "saveStatus"
  >;
  retranslatePage: AppSessionViewModel["retranslatePage"];
  settingsDialog: Pick<AppSessionViewModel["settingsDialog"], "settings">;
  statusLog: Pick<
    AppSessionViewModel["statusLog"],
    "clearStatusLines" | "statusLines"
  >;
  uiState: Pick<
    AppSessionViewModel["uiState"],
    | "openTranslateOptions"
    | "rightRailMode"
    | "selectWorkspaceTool"
    | "setAutoInpaintingEntryScope"
    | "setAutoInpaintingOptionsOpen"
    | "setExportOptionsOpen"
    | "setPeekOriginal"
    | "setRightRailMode"
    | "setShowBlockChrome"
    | "setShowTextBlocks"
    | "setStyleGuideOpen"
    | "setTextViewOpen"
    | "showBlockChrome"
    | "showTextBlocks"
    | "stageTool"
    | "translationFlowActive"
  >;
  workspaceHistory: Pick<
    AppSessionViewModel["workspaceHistory"],
    "busy" | "canRedo" | "canUndo" | "redo" | "redoLabel" | "undo" | "undoLabel"
  >;
};

export function createRightRailProps(
  model: RightRailViewModel,
): RightRailProps {
  const {
    bridgeActions,
    core,
    derivedState,
    inpaintingBridge,
    persistence,
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
      derivedState.selectedPageEditLocked || workspaceHistory.busy,
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
    saveStatus: persistence.saveStatus,
    showBlockChrome: uiState.showBlockChrome,
    showProgressBar: derivedState.showProgressBar,
    showTextBlocks: uiState.showTextBlocks,
    stageTool: uiState.stageTool,
    statusLines: statusLog.statusLines,
    undoLabel: workspaceHistory.undoLabel,
    onCancelJob: bridgeActions.cancelJob,
    onClearStatusLines: statusLog.clearStatusLines,
    onOpenLogFolder: bridgeActions.openLogFolder,
  };
}

function createRightRailActions({
  blockEditingActions,
  core,
  inpaintingActions,
  inpaintingBridge,
  persistence,
  retranslatePage,
  uiState,
  workspaceHistory,
}: RightRailViewModel) {
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
    onReviewResults: () => uiState.setRightRailMode("page-blocks"),
    onRetryPage: (pageId: string) => void retranslatePage(pageId),
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
    onRetrySave: () => void persistence.saveNow(),
    onSelectBlock: (blockId: string) => {
      selectBlock(blockId);
      uiState.setRightRailMode("page-blocks");
    },
    onToggleBlocks: () => uiState.setShowTextBlocks((visible) => !visible),
    onToggleChrome: () => uiState.setShowBlockChrome((visible) => !visible),
    onUndo: () => void workspaceHistory.undo(),
    onUpdateBlock: blockEditingActions.updateBlock,
  };
}

function prepareAutoInpainting(
  core: RightRailViewModel["core"],
  uiState: RightRailViewModel["uiState"],
  scope: AutoInpaintingEntryScope,
): void {
  core.setRegionSelection(null);
  uiState.selectWorkspaceTool("select");
  uiState.setPeekOriginal(false);
  uiState.setAutoInpaintingEntryScope(scope);
  uiState.setAutoInpaintingOptionsOpen(true);
}
