import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";
import { resolveReadingDirection } from "../../../../shared/blockReadingOrder";
import type { AutoInpaintingEntryScope } from "../../lib/autoInpaintingSelection";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { openManualErrorReport } from "../../lib/errorReportStore";

type RightRailProps = AppSessionViewProps["rightRailProps"];
type RightRailViewModel = {
  blockEditingActions: Pick<
    AppSessionViewModel["blockEditingActions"],
    "updateBlock"
  > &
    Partial<
      Pick<
        AppSessionViewModel["blockEditingActions"],
        "moveSelectedBlockInReadingOrder" | "sortPageReadingOrder"
      >
    >;
  bridgeActions: Pick<AppSessionViewModel["bridgeActions"], "cancelJob">;
  core: Pick<
    AppSessionViewModel["core"],
    | "currentChapter"
    | "jobState"
    | "selectedBlockId"
    | "selectedBlockIdRef"
    | "setRegionSelection"
    | "setSelectedBlockId"
    | "setSelectedBlockIds"
  > & {
    library?: AppSessionViewModel["core"]["library"];
    selectedBlockIds?: AppSessionViewModel["core"]["selectedBlockIds"];
  };
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
    > &
      Partial<
        Pick<
          AppSessionViewModel["inpaintingBridge"]["contextValue"],
          "onAdjustPatternMask"
        >
      >;
  };
  linkedWorkspace?: AppSessionViewModel["linkedWorkspace"];
  importShareModal?: Pick<
    AppSessionViewModel["importShareModal"],
    "importBusy"
  >;
  operationActivity?: AppSessionViewModel["operationActivity"];
  completionSound: Pick<
    AppSessionViewModel["completionSound"],
    | "muted"
    | "volume"
    | "translationMuted"
    | "sourceErasingMuted"
    | "researchMuted"
    | "setPreferences"
  >;
  persistence: Pick<
    AppSessionViewModel["persistence"],
    "saveNow" | "saveStatus"
  >;
  retranslatePage: AppSessionViewModel["retranslatePage"];
  settingsDialog: Pick<AppSessionViewModel["settingsDialog"], "settings">;
  statusLog: Pick<
    AppSessionViewModel["statusLog"],
    "clearStatusLines" | "statusEntries" | "statusLines"
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
    | "openTextView"
    | "showBlockChrome"
    | "showTextBlocks"
    | "stageTool"
    | "translationFlowActive"
  > &
    Partial<Pick<AppSessionViewModel["uiState"], "openExportOptions">>;
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
    statusLog,
    uiState,
    workspaceHistory,
  } = model;
  const inpainting = inpaintingBridge.contextValue;
  return {
    ...createRightRailActions(model),
    ...resolveLinkedWorkspaceProps(model),
    blockReadingDirection: resolveRightRailReadingDirection(model),
    brushColor: inpainting.brushColor,
    brushRadius: inpainting.brushRadius,
    canRedo: workspaceHistory.canRedo,
    canRunBubbleLayout: canRunRightRailBubbleLayout(model),
    canUndo: workspaceHistory.canUndo,
    compareAvailable: derivedState.peekAvailable,
    completionSoundMuted: model.completionSound.muted,
    completionSoundVolume: model.completionSound.volume,
    completionSoundTranslationMuted: model.completionSound.translationMuted,
    completionSoundSourceErasingMuted: model.completionSound.sourceErasingMuted,
    completionSoundResearchMuted: model.completionSound.researchMuted,
    currentChapter: core.currentChapter,
    editorDisabled: isRightRailEditorDisabled(model),
    exclusiveActivityActive:
      Boolean(model.operationActivity?.active) ||
      Boolean(model.importShareModal?.importBusy),
    flowActive: uiState.translationFlowActive,
    jobActive: isRightRailJobActive(model),
    jobState: core.jobState,
    operationActivity: model.operationActivity?.activity ?? null,
    maskStrokeCount: inpainting.maskStrokeCount,
    peeking: derivedState.showingOriginalPeek,
    progressSnapshot: derivedState.progressSnapshot,
    redoLabel: workspaceHistory.redoLabel,
    resetAvailable: Boolean(derivedState.selectedPage?.inpaintedImagePath),
    rightRailMode: uiState.rightRailMode,
    selectedBlock: derivedState.selectedBlock,
    selectedBlockId: core.selectedBlockId,
    selectedBlockIds: core.selectedBlockIds ?? [],
    selectedPage: derivedState.selectedPage,
    saveStatus: persistence.saveStatus,
    showBlockChrome: uiState.showBlockChrome,
    showProgressBar: derivedState.showProgressBar,
    showTextBlocks: uiState.showTextBlocks,
    stageTool: uiState.stageTool,
    statusEntries: statusLog.statusEntries,
    statusLines: statusLog.statusLines,
    undoLabel: workspaceHistory.undoLabel,
    onCancelJob: bridgeActions.cancelJob,
    onClearStatusLines: () => {
      statusLog.clearStatusLines();
      model.operationActivity?.clearTerminal();
    },
    onCancelOperation: () => void model.operationActivity?.cancel(),
    onCompletionSoundChange: model.completionSound.setPreferences,
    onOpenErrorReport: openManualErrorReport,
    onViewLinkedResults: () => void model.linkedWorkspace?.viewResults(),
  };
}

function resolveRightRailReadingDirection(model: RightRailViewModel) {
  const work = model.core.library?.works.find(
    (candidate) => candidate.id === model.core.currentChapter?.workId,
  );
  return resolveReadingDirection(
    work?.readingDirection,
    resolveSourceReadingDirection(
      model.settingsDialog.settings?.translation?.sourceLanguage,
    ),
  );
}

function resolveLinkedWorkspaceProps(model: RightRailViewModel) {
  return {
    linkedWorkspaceStatus: model.linkedWorkspace?.status ?? null,
    linkedWorkspaceViewBusy: model.linkedWorkspace?.viewBusy ?? false,
  };
}

function canRunRightRailBubbleLayout(model: RightRailViewModel): boolean {
  const page = model.derivedState.selectedPage;
  return Boolean(page?.inpaintedImagePath && page.blocks.length);
}

function isRightRailEditorDisabled(model: RightRailViewModel): boolean {
  return (
    model.derivedState.selectedPageEditLocked || model.workspaceHistory.busy
  );
}

function isRightRailJobActive(model: RightRailViewModel): boolean {
  if (model.operationActivity?.active || model.importShareModal?.importBusy) {
    return (
      model.derivedState.selectedPageEditLocked ||
      model.uiState.translationFlowActive ||
      model.workspaceHistory.busy
    );
  }
  return (
    model.inpaintingBridge.contextValue.jobActive ||
    model.uiState.translationFlowActive ||
    model.workspaceHistory.busy
  );
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
    onAdjustPatternMask: inpainting.onAdjustPatternMask ?? (() => undefined),
    onClearPatternMask: inpainting.onClearPatternMask,
    onChangeBlockSelection: (
      blockIds: string[],
      primaryBlockId: string | null,
    ) => {
      core.selectedBlockIdRef.current = primaryBlockId;
      core.setSelectedBlockId(primaryBlockId);
      core.setSelectedBlockIds(blockIds);
    },
    onOpenAutoInpaintingOptions: (scope: AutoInpaintingEntryScope) => {
      prepareAutoInpainting(core, uiState, scope);
    },
    onOpenBlockEditor: (blockId: string) => {
      selectBlock(blockId);
      uiState.setRightRailMode("block-editor");
    },
    onOpenExport: () => openExportOptions(uiState, "raster"),
    onOpenPsdExport: () => openExportOptions(uiState, "psd"),
    onReviewResults: () => uiState.setRightRailMode("page-blocks"),
    onRetryPage: (pageId: string) => void retranslatePage(pageId),
    onOpenStyleGuide: () => uiState.setStyleGuideOpen(true),
    onOpenTextView: () => uiState.openTextView("overview"),
    onOpenTranslateOptions: () => uiState.openTranslateOptions(),
    onPeekToggle: inpainting.onPeekToggle,
    onMoveBlockInReadingOrder: (blockId: string, direction: -1 | 1) => {
      selectBlock(blockId);
      blockEditingActions.moveSelectedBlockInReadingOrder?.(direction, blockId);
    },
    onRedo: () => void workspaceHistory.redo(),
    onResetPage: () => {
      uiState.setPeekOriginal(false);
      void inpaintingActions.revertInpainting("page");
    },
    onRunBubbleLayout: () => void inpaintingActions.runBubbleLayout(),
    onRunDrawnPattern: inpainting.onRunDrawnPattern,
    onRetrySave: () => void persistence.saveNow(),
    onSelectBlock: (blockId: string) => {
      selectBlock(blockId);
      uiState.setRightRailMode("page-blocks");
    },
    onSortReadingOrder:
      blockEditingActions.sortPageReadingOrder ?? (() => undefined),
    onToggleBlocks: () => uiState.setShowTextBlocks((visible) => !visible),
    onToggleChrome: () => uiState.setShowBlockChrome((visible) => !visible),
    onUndo: () => void workspaceHistory.undo(),
    onUpdateBlock: blockEditingActions.updateBlock,
  };
}

function openExportOptions(
  uiState: RightRailViewModel["uiState"],
  kind: "raster" | "psd",
): void {
  if (uiState.openExportOptions) {
    uiState.openExportOptions(kind);
    return;
  }
  uiState.setExportOptionsOpen(true);
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
