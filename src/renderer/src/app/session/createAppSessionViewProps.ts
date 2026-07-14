import { applyTranslatedTextUpdates } from "./applyTranslatedTextUpdates";
import type { PanelSessionValue } from "../../panels/panelSession";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { buildPanelSyncState } from "./buildPanelSyncState";
import {
  createPageRetranslateProps,
  createTranslationOptionsProps,
} from "./createTranslationModalProps";
import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";

export type { AppSessionViewModel } from "./appSessionViewModel";

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
        library: core.library,
        onClose: () => uiState.setAutoInpaintingOptionsOpen(false),
        onStart: (selection) => {
          uiState.setPeekOriginal(false);
          return inpaintingActions.runInpaintingSelection(selection);
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

function createGatherTextProps({
  core,
  derivedState,
  libraryActions,
  pageNavigationHandlers,
  settingsDialog,
  uiState,
  updateCurrentChapter,
  workspaceHistory,
}: AppSessionViewModel): AppSessionViewProps["gatherTextProps"] {
  return uiState.textViewOpen
    ? {
        chapter: core.currentChapter,
        onApplyTranslatedText: (updates) =>
          applyTranslatedTextUpdates(updates, updateCurrentChapter),
        onChapterUpdated: (updatedChapter) => {
          workspaceHistory.reset();
          libraryActions.applyChapter(updatedChapter);
        },
        onClose: () => uiState.setTextViewOpen(false),
        onNavigateToBlock: (pageId, blockId) => {
          pageNavigationHandlers.selectPageForReading(pageId);
          core.selectedBlockIdRef.current = blockId;
          core.setSelectedBlockId(blockId);
          core.setSelectedBlockIds([blockId]);
          uiState.setTextViewOpen(false);
        },
        page: derivedState.selectedPage,
        readingDirection: resolveSourceReadingDirection(
          settingsDialog.settings?.translation?.sourceLanguage,
        ),
      }
    : null;
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
    editorFloating: uiState.editorFloating,
    editorPoppedOut: panelBridge.openPanelIds.includes("editor"),
    showDetachControls: true,
    onApplyFormat: blockEditingActions.applyFormatToScope,
    onToggleEditorFloat: uiState.toggleEditorFloat,
    onPopOutEditor: panelBridge.openEditorWindow,
    onDockEditorWindow: panelBridge.closeEditorWindow,
    onDeleteBlock: blockEditingActions.deleteSelectedBlock,
    onDuplicateBlock: blockEditingActions.duplicateSelectedBlock,
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
    onOpenTranslateOptions: () => uiState.setTranslateOptionsOpen(true),
    onRunDrawnPattern: inpainting.onRunDrawnPattern,
    onRunCurrentPageInpainting: () => {
      uiState.setPeekOriginal(false);
      void inpaintingActions.runInpainting("page");
    },
    onShowGuide: inpainting.onShowGuide,
    onOpenAutoInpaintingOptions: () => {
      core.setRegionSelection(null);
      uiState.selectWorkspaceTool("select");
      uiState.setPeekOriginal(false);
      uiState.setAutoInpaintingOptionsOpen(true);
    },
    onToggleBlocks: () => uiState.setShowTextBlocks((value) => !value),
    onToggleChrome: () => uiState.setShowBlockChrome((value) => !value),
    progressSnapshot: derivedState.progressSnapshot,
    selectedBlock: derivedState.selectedBlock,
    selectedPage: derivedState.selectedPage,
    showBlockChrome: uiState.showBlockChrome,
    showProgressBar: derivedState.showProgressBar,
    showTextBlocks: uiState.showTextBlocks,
    stageTool: uiState.stageTool,
    statusLines: statusLog.statusLines,
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
  settingsDialog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["styleGuideProps"] {
  return uiState.styleGuideOpen && core.currentChapter
    ? {
        chapter: core.currentChapter,
        onClose: () => uiState.setStyleGuideOpen(false),
        settings: settingsDialog.settings,
      }
    : null;
}

function createWorkspaceProps({
  core,
  derivedState,
  importShareActions,
  importShareModal,
  inpaintingActions,
  inpaintingBridge,
  pointerHandlers,
  settingsDialog,
  uiState,
  workspaceHistory,
}: AppSessionViewModel): AppSessionViewProps["workspaceProps"] {
  return {
    blockCreateRect: pointerHandlers.blockCreateRect,
    dragHud: pointerHandlers.dragHud,
    imageRef: core.imageRef,
    brushColor: uiState.inpaintingPaintColor,
    brushRadius: uiState.inpaintingBrushRadius,
    canRedo: workspaceHistory.canRedo,
    canUndo: workspaceHistory.canUndo,
    compareAvailable: derivedState.peekAvailable,
    jobActive:
      inpaintingBridge.contextValue.jobActive ||
      uiState.translationFlowActive ||
      workspaceHistory.busy,
    jobState: core.jobState,
    maskStrokes: derivedState.patternMaskStrokes,
    resetAvailable: Boolean(derivedState.selectedPage?.inpaintedImagePath),
    onBlockPointerDown: pointerHandlers.onBlockPointerDown,
    onOpenBatchImport: () =>
      void importShareActions.openImportPreview("zip-folder"),
    onOpenSettings: () => void settingsDialog.openSettings(),
    onOpenShareImport: () => void importShareActions.openShareImportPreview(),
    onOpenTranslationSource: () =>
      importShareModal.setTranslationSourceOpen(true),
    onPeekToggle: inpaintingBridge.contextValue.onPeekToggle,
    onRedo: () => void workspaceHistory.redo(),
    onResetPage: () => {
      uiState.setPeekOriginal(false);
      void inpaintingActions.revertInpainting("page");
    },
    onSelectStageTool: (tool) => {
      core.setRegionSelection(null);
      uiState.selectWorkspaceTool(tool);
    },
    onStagePointerDown: pointerHandlers.onStagePointerDown,
    onStagePointerLeave: pointerHandlers.onStagePointerLeave,
    onStagePointerMove: pointerHandlers.onStagePointerMove,
    onStagePointerUp: pointerHandlers.onStagePointerUp,
    onToggleStageToolbarHidden: () =>
      uiState.setStageToolbarHidden((hidden) => !hidden),
    progressSnapshot: derivedState.progressSnapshot,
    redoLabel: workspaceHistory.redoLabel,
    regionSelectionActive: Boolean(core.regionSelection?.active),
    regionSelectionRect: derivedState.regionSelectionRect,
    retouchCursor: inpaintingBridge.retouchCursor,
    retouchOriginalImageDataUrl: derivedState.selectedPageOriginalImageDataUrl,
    selectedBlockId: core.selectedBlockId,
    selectedBlockIds: derivedState.selectedBlockIds,
    selectedPage: derivedState.selectedPage,
    selectedPageImageDataUrl: derivedState.workspaceImageDataUrl,
    selectedPageImagePageId: derivedState.workspaceImagePageId,
    showBlockChrome: uiState.showBlockChrome,
    showTextBlocks: uiState.showTextBlocks,
    showingOriginalPeek: derivedState.showingOriginalPeek,
    stageRef: core.stageRef,
    stageSize: derivedState.stageSize,
    stageTool: uiState.stageTool,
    stageToolbarHidden: uiState.stageToolbarHidden,
    undoLabel: workspaceHistory.undoLabel,
    onUndo: () => void workspaceHistory.undo(),
    workspacePanelRef: core.workspacePanelRef,
    workspaceZoom: uiState.workspaceZoom,
  };
}
