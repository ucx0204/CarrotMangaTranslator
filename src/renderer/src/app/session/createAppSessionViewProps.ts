import type { PanelSessionValue } from "../../panels/panelSession";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { buildPanelSyncState } from "./buildPanelSyncState";
import {
  createPageRetranslateProps,
  createTranslationOptionsProps,
} from "./createTranslationModalProps";
import { createGatherTextProps } from "./createGatherTextProps";
import { createPanelBlockActions } from "./createPanelBlockActions";
import { isWorkspaceImageReadyForSelectedPage } from "./appSessionSelectors";
import { createWorkspaceViewProps } from "./createWorkspaceViewProps";

export function createAppSessionViewProps(
  model: AppSessionViewModel,
): AppSessionViewProps {
  return {
    autoInpaintingOptionsProps: createAutoInpaintingOptionsProps(model),
    commandPaletteProps: createCommandPaletteProps(model),
    exportOptionsProps: createExportOptionsProps(model),
    gatherTextProps: createGatherTextProps(model),
    modalsProps: createModalsProps(model),
    pageRetranslateProps: createPageRetranslateProps(model),
    panelSessionValue: createPanelSessionValue(model),
    rightRailProps: createRightRailProps(model),
    shortcutHelpProps: createShortcutHelpProps(model),
    sidebarProps: createSidebarProps(model),
    styleGuideProps: createStyleGuideProps(model),
    translationOptionsProps: createTranslationOptionsProps(model),
    workspaceProps: createWorkspaceProps(model),
  };
}

function createAutoInpaintingOptionsProps({
  core,
  derivedState,
  inpaintingActions,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["autoInpaintingOptionsProps"] {
  return uiState.autoInpaintingOptionsOpen &&
    core.currentChapter &&
    derivedState.selectedPage
    ? {
        chapter: core.currentChapter,
        currentPageId: derivedState.selectedPage.id,
        initialScope: uiState.autoInpaintingEntryScope,
        library: core.library,
        onClose: () => uiState.setAutoInpaintingOptionsOpen(false),
        onStart: (selection, postprocess) => {
          uiState.setPeekOriginal(false);
          return inpaintingActions.runInpaintingSelection(
            selection,
            postprocess,
          );
        },
      }
    : null;
}

function createExportOptionsProps({
  core,
  derivedState,
  inpaintingActions,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["exportOptionsProps"] {
  return uiState.exportOptionsOpen &&
    core.currentChapter &&
    derivedState.selectedPage
    ? {
        chapter: core.currentChapter,
        currentPageId: derivedState.selectedPage.id,
        jobActive: derivedState.jobActive,
        library: core.library,
        onClose: () => uiState.setExportOptionsOpen(false),
        onStart: inpaintingActions.exportPageImages,
      }
    : null;
}

function createCommandPaletteProps({
  commands,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["commandPaletteProps"] {
  return {
    commands,
    onClose: () => uiState.setCommandPaletteOpen(false),
    open: uiState.commandPaletteOpen,
  };
}

function createModalsProps({
  bridgeActions,
  confirmController,
  core,
  guidePreference,
  importShareActions,
  importShareModal,
  derivedState,
  libraryActions,
  settingsDialog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["modalsProps"] {
  return {
    confirmDialog: confirmController.confirmDialog,
    currentWorkId: core.currentChapter?.workId ?? null,
    importBusy: importShareModal.importBusy,
    importPreview: importShareModal.importPreview,
    inpaintingGuideOpen: uiState.inpaintingGuideOpen,
    jobActive: derivedState.jobActive,
    library: core.library,
    onCancelImport: () => importShareModal.setImportPreview(null),
    onCancelRename: () => {
      if (!libraryActions.renameBusy) {
        libraryActions.setRenameTarget(null);
      }
    },
    onCancelSettings: settingsDialog.closeSettings,
    onCancelShareExport: () => {
      if (!importShareModal.shareExportBusy) {
        importShareModal.setShareExportOpen(false);
      }
    },
    onCancelShareImport: () => {
      if (!importShareModal.shareImportBusy) {
        importShareModal.setShareImportPreview(null);
      }
    },
    onCancelTranslationSource: () =>
      importShareModal.setTranslationSourceOpen(false),
    onCloseInpaintingGuide: guidePreference.closeInpaintingGuide,
    onDeleteRename: () => void libraryActions.deleteRenameTarget(),
    onOpenLogFolder: bridgeActions.openLogFolder,
    onResetSettings: () => void settingsDialog.resetSettings(),
    onResolveConfirm: confirmController.resolveConfirmDialog,
    onSelectTranslationSource: (mode) =>
      void importShareActions.selectTranslateSource(mode),
    onSubmitImport: (payload) => void importShareActions.submitImport(payload),
    onSubmitRename: (title) => void libraryActions.submitRename(title),
    onSubmitSettings: (nextSettings) =>
      void settingsDialog.submitSettings(nextSettings),
    onSubmitShareExport: (request) =>
      void importShareActions.submitShareExport(request),
    onSubmitShareImport: (payload) =>
      void importShareActions.submitShareImport(payload),
    renameBusy: libraryActions.renameBusy,
    renameTarget: libraryActions.renameTarget,
    settings: settingsDialog.settings,
    settingsBusy: settingsDialog.settingsBusy,
    settingsOpen: settingsDialog.settingsOpen,
    shareExportBusy: importShareModal.shareExportBusy,
    shareExportOpen: importShareModal.shareExportOpen,
    shareImportBusy: importShareModal.shareImportBusy,
    shareImportPreview: importShareModal.shareImportPreview,
    translationSourceOpen: importShareModal.translationSourceOpen,
  };
}

function createPanelSessionValue(
  model: AppSessionViewModel,
): PanelSessionValue {
  const { blockEditingActions, panelBridge, pointerHandlers, uiState } = model;
  return {
    ...buildPanelSyncState(model),
    ...createPanelBlockActions(model),
    editorFloating: uiState.editorFloating,
    editorPoppedOut: panelBridge.openPanelIds.includes("editor"),
    showDetachControls: true,
    onAdjustFontSize: blockEditingActions.adjustSelectedBlockFontSize,
    onApplyFormat: blockEditingActions.applyFormatToScope,
    onApplyBlockBackgroundOpacity:
      blockEditingActions.applyBlockBackgroundOpacityToScope,
    onToggleEditorFloat: uiState.toggleEditorFloat,
    onPopOutEditor: panelBridge.openEditorWindow,
    onDockEditorWindow: panelBridge.closeEditorWindow,
    onDeleteBlock: blockEditingActions.deleteSelectedBlock,
    onDuplicateBlock: blockEditingActions.duplicateSelectedBlock,
    onRemoveBubbleLayout: blockEditingActions.removeSelectedBlockBubbleLayout,
    onSelectTransformMode: (mode) => {
      uiState.selectWorkspaceTool(mode);
    },
    onStartAreaTranslate: pointerHandlers.startRegionTranslationSelection,
    onUpdateBlock: blockEditingActions.updateSelectedBlock,
  };
}

function createRightRailProps({
  bridgeActions,
  core,
  derivedState,
  inpaintingActions,
  inpaintingBridge,
  statusLog,
  uiState,
  workspaceHistory,
}: AppSessionViewModel): AppSessionViewProps["rightRailProps"] {
  const inpainting = inpaintingBridge.contextValue;
  return {
    brushColor: inpainting.brushColor,
    brushRadius: inpainting.brushRadius,
    canRedo: workspaceHistory.canRedo,
    canUndo: workspaceHistory.canUndo,
    canRunBubbleLayout: Boolean(
      derivedState.selectedPage?.inpaintedImagePath &&
      derivedState.selectedPage.blocks.length,
    ),
    compareAvailable: derivedState.peekAvailable,
    currentChapter: core.currentChapter,
    flowActive: uiState.translationFlowActive,
    jobActive:
      inpainting.jobActive ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    jobState: core.jobState,
    maskStrokeCount: inpainting.maskStrokeCount,
    onCancelJob: bridgeActions.cancelJob,
    onBrushColorChange: inpainting.onBrushColorChange,
    onBrushRadiusChange: inpainting.onBrushRadiusChange,
    onClearPatternMask: inpainting.onClearPatternMask,
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
    onRunDrawnPattern: inpainting.onRunDrawnPattern,
    onRunBubbleLayout: () => void inpaintingActions.runBubbleLayout(),
    onRunCurrentPageInpainting: () => {
      core.setRegionSelection(null);
      uiState.selectWorkspaceTool("select");
      uiState.setPeekOriginal(false);
      uiState.setAutoInpaintingEntryScope("current");
      uiState.setAutoInpaintingOptionsOpen(true);
    },
    onOpenAutoInpaintingOptions: (scope) => {
      core.setRegionSelection(null);
      uiState.selectWorkspaceTool("select");
      uiState.setPeekOriginal(false);
      uiState.setAutoInpaintingEntryScope(scope);
      uiState.setAutoInpaintingOptionsOpen(true);
    },
    onUndo: () => void workspaceHistory.undo(),
    peeking: derivedState.showingOriginalPeek,
    progressSnapshot: derivedState.progressSnapshot,
    redoLabel: workspaceHistory.redoLabel,
    resetAvailable: Boolean(derivedState.selectedPage?.inpaintedImagePath),
    selectedBlock: derivedState.selectedBlock,
    selectedPage: derivedState.selectedPage,
    showBlockChrome: uiState.showBlockChrome,
    showProgressBar: derivedState.showProgressBar,
    showTextBlocks: uiState.showTextBlocks,
    stageTool: uiState.stageTool,
    statusLines: statusLog.statusLines,
    undoLabel: workspaceHistory.undoLabel,
    onToggleBlocks: () => uiState.setShowTextBlocks((visible) => !visible),
    onToggleChrome: () => uiState.setShowBlockChrome((visible) => !visible),
  };
}

function createShortcutHelpProps({
  settingsDialog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["shortcutHelpProps"] {
  return {
    onClose: () => uiState.setShortcutHelpOpen(false),
    open: uiState.shortcutHelpOpen,
    overrides: settingsDialog.settings?.keybindings ?? {},
  };
}

function createSidebarProps({
  bridgeActions,
  core,
  derivedState,
  importShareActions,
  importShareModal,
  inpaintingBridge,
  libraryActions,
  pageNavigationHandlers,
  retranslatePage,
  settingsDialog,
  uiState,
  workspaceHistory,
}: AppSessionViewModel): AppSessionViewProps["sidebarProps"] {
  return {
    currentChapter: core.currentChapter,
    jobActive:
      inpaintingBridge.contextValue.jobActive ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    library: core.library,
    onOpenBatchImport: () =>
      void importShareActions.openImportPreview("zip-folder"),
    onOpenChapter: (chapterId) => void libraryActions.openChapter(chapterId),
    onOpenLibraryFolder: bridgeActions.openLibraryFolder,
    onOpenSettings: () => void settingsDialog.openSettings(),
    onOpenShareExport: () => importShareModal.setShareExportOpen(true),
    onOpenShareImport: () => void importShareActions.openShareImportPreview(),
    onOpenTranslationSource: () =>
      importShareModal.setTranslationSourceOpen(true),
    onRemovePage: (pageId) => void libraryActions.removePage(pageId),
    onRenameChapter: (chapterId) =>
      void libraryActions.renameChapter(chapterId),
    onRenameWork: (workId) => void libraryActions.renameWork(workId),
    onReorderChapter: libraryActions.reorderChapterInLibrary,
    onReorderPage: libraryActions.reorderPageInChapter,
    onRetranslatePage: (pageId) => void retranslatePage(pageId),
    onSelectPage: pageNavigationHandlers.selectPageForReading,
    selectedPageId: derivedState.selectedPage?.id ?? null,
    settingsBusy: settingsDialog.settingsBusy,
    settingsOpen: settingsDialog.settingsOpen,
  };
}

function createStyleGuideProps({
  core,
  derivedState,
  settingsDialog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["styleGuideProps"] {
  return uiState.styleGuideOpen && core.currentChapter
    ? {
        chapter: core.currentChapter,
        jobActive: derivedState.jobActive,
        onClose: () => uiState.setStyleGuideOpen(false),
        settings: settingsDialog.settings,
      }
    : null;
}

function isRegionTranslationAvailable(
  derivedState: AppSessionViewModel["derivedState"],
): boolean {
  return isWorkspaceImageReadyForSelectedPage({
    selectedPage: derivedState.selectedPage,
    workspaceImageDataUrl: derivedState.workspaceImageDataUrl,
    workspaceImagePageId: derivedState.workspaceImagePageId,
  });
}

function createWorkspaceProps({
  core,
  derivedState,
  importShareActions,
  importShareModal,
  inpaintingBridge,
  pointerHandlers,
  settingsDialog,
  uiState,
  workspaceHistory,
}: AppSessionViewModel): AppSessionViewProps["workspaceProps"] {
  return {
    ...createWorkspaceViewProps(uiState),
    interactionPreviewStore: pointerHandlers.interactionPreviewStore,
    imageRef: core.imageRef,
    brushColor: uiState.inpaintingPaintColor,
    brushRadius: uiState.inpaintingBrushRadius,
    jobActive:
      inpaintingBridge.contextValue.jobActive ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    jobState: core.jobState,
    maskStrokes: derivedState.patternMaskStrokes,
    lastRetouchTool: uiState.lastRetouchTool,
    onBlockPointerDown: pointerHandlers.onBlockPointerDown,
    onApplyBubbleLayoutDraft: pointerHandlers.applyBubbleLayoutDraft,
    onCancelBubbleLayoutDraft: pointerHandlers.cancelBubbleLayoutDraft,
    onOpenBatchImport: () =>
      void importShareActions.openImportPreview("zip-folder"),
    onOpenSettings: () => void settingsDialog.openSettings(),
    onOpenShareImport: () => void importShareActions.openShareImportPreview(),
    onOpenTranslationSource: () =>
      importShareModal.setTranslationSourceOpen(true),
    onSelectStageTool: (tool) => {
      core.setRegionSelection(null);
      uiState.selectWorkspaceTool(tool);
    },
    onToggleRegionTranslation: pointerHandlers.startRegionTranslationSelection,
    onStagePointerDown: pointerHandlers.onStagePointerDown,
    onStagePointerLeave: pointerHandlers.onStagePointerLeave,
    onStagePointerMove: pointerHandlers.onStagePointerMove,
    onStagePointerUp: pointerHandlers.onStagePointerUp,
    onUndoBubbleLayoutPoint: pointerHandlers.undoBubbleLayoutPoint,
    onToggleStageToolbarHidden: () =>
      uiState.setStageToolbarHidden((hidden) => !hidden),
    progressSnapshot: derivedState.progressSnapshot,
    regionSelectionActive: Boolean(core.regionSelection?.active),
    regionTranslationAvailable: isRegionTranslationAvailable(derivedState),
    regionSelectionRect: derivedState.regionSelectionRect,
    retouchCursor: inpaintingBridge.retouchCursor,
    retouchOriginalImageDataUrl: derivedState.selectedPageOriginalImageDataUrl,
    selectedBlockId: core.selectedBlockId,
    selectedBlockIds: derivedState.selectedBlockIds,
    selectedPage: derivedState.selectedPage,
    selectedPageImageDataUrl: derivedState.workspaceImageDataUrl,
    selectedPageImageLoading: derivedState.workspaceImageLoading,
    selectedPageImagePageId: derivedState.workspaceImagePageId,
    showBlockChrome: uiState.showBlockChrome,
    showTextBlocks: uiState.showTextBlocks,
    showingOriginalPeek: derivedState.showingOriginalPeek,
    stageRef: core.stageRef,
    stageSize: derivedState.stageSize,
    stageTool: uiState.stageTool,
    stageToolbarHidden: uiState.stageToolbarHidden,
    workspacePanelRef: core.workspacePanelRef,
  };
}
