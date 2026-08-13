import type { PanelSessionValue } from "../../panels/panelSession";
import type { AppSessionViewProps } from "./AppSessionView";
import type { AppSessionViewModel } from "./appSessionViewModel";
import { buildPanelSyncState } from "./buildPanelSyncState";
import {
  createPageRetranslateProps,
  createTranslationOptionsProps,
} from "./createTranslationModalProps";
import { createGatherTextProps } from "./createGatherTextProps";
import {
  createCommandPaletteProps,
  createShortcutHelpProps,
} from "./createAppOverlayProps";
import { createPanelBlockActions } from "./createPanelBlockActions";
import { isWorkspaceImageReadyForSelectedPage } from "./appSessionSelectors";
import { createWorkspaceViewProps } from "./createWorkspaceViewProps";
import { createRightRailProps } from "./createRightRailProps";
import { createStylePresetSaveAction } from "./createStylePresetSaveAction";
import { createStylePresetDeleteAction } from "./createStylePresetDeleteAction";
import { applySearchReplace } from "../../lib/searchReplace";
import { appI18n } from "../../appI18n";
import { toast } from "../../lib/toastStore";

export function createAppSessionViewProps(
  model: AppSessionViewModel,
): AppSessionViewProps {
  return {
    autoInpaintingOptionsProps: createAutoInpaintingOptionsProps(model),
    commandPaletteProps: createCommandPaletteProps(model),
    exportOptionsProps: createExportOptionsProps(model),
    gatherTextProps: createGatherTextProps(model),
    libraryDropOverlayProps: model.libraryDrop,
    modalsProps: createModalsProps(model),
    pageRetranslateProps: createPageRetranslateProps(model),
    panelSessionValue: createPanelSessionValue(model),
    rightRailProps: createRightRailProps(model),
    searchReplaceProps: createSearchReplaceProps(model),
    shortcutHelpProps: createShortcutHelpProps(model),
    sidebarProps: createSidebarProps(model),
    styleGuideProps: createStyleGuideProps(model),
    translationOptionsProps: createTranslationOptionsProps(model),
    workspaceProps: createWorkspaceProps(model),
  };
}

function createSearchReplaceProps({
  core,
  derivedState,
  pageNavigationHandlers,
  statusLog,
  uiState,
  updateCurrentChapter,
  workspaceHistory,
}: AppSessionViewModel): AppSessionViewProps["searchReplaceProps"] {
  const chapter = core.currentChapter;
  if (!uiState.searchReplaceOpen || !chapter) return null;
  return {
    chapter,
    disabled: derivedState.selectedPageEditLocked || workspaceHistory.busy,
    page: derivedState.selectedPage,
    onClose: () => uiState.setSearchReplaceOpen(false),
    onNavigateToBlock: (pageId, blockId) => {
      pageNavigationHandlers.selectPageForReading(pageId);
      core.selectedBlockIdRef.current = blockId;
      core.setSelectedBlockId(blockId);
      core.setSelectedBlockIds([blockId]);
      uiState.setSearchReplaceOpen(false);
      uiState.setRightRailMode("block-editor");
    },
    onApply: (request) => {
      const result = applySearchReplace(
        chapter,
        derivedState.selectedPage?.id ?? null,
        request,
      );
      const firstChangedPageId = result.changedPageIds[0];
      if (!firstChangedPageId) return;
      updateCurrentChapter(firstChangedPageId, () => result.chapter, {
        dirtyPageIds: result.changedPageIds,
        label: appI18n.t("workspaceHistory.searchReplace", {
          ns: "renderer",
        }),
      });
      const message = appI18n.t("searchReplace.replaced", {
        ns: "renderer",
        count: result.replacementCount,
      });
      statusLog.pushStatus(message);
      toast.success(message);
      uiState.setSearchReplaceOpen(false);
    },
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
  libraryActions,
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
        onNavigateToIssue: (chapterId, pageId) => {
          void (async () => {
            if (core.currentChapter?.id !== chapterId) {
              await libraryActions.openChapter(chapterId);
            }
            core.setSelectedPageId(pageId);
            core.setSelectedBlockId(null);
            uiState.setExportOptionsOpen(false);
          })();
        },
        onStart: inpaintingActions.exportPageImages,
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
  libraryDrop,
  derivedState,
  libraryActions,
  settingsDialog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["modalsProps"] {
  return {
    confirmDialog: confirmController.confirmDialog,
    currentWorkId: core.currentChapter?.workId ?? null,
    importBusy: importShareModal.importBusy || libraryDrop.busy,
    importPreview: importShareModal.importPreview,
    inpaintingGuideOpen: uiState.inpaintingGuideOpen,
    jobActive: derivedState.jobActive,
    library: core.library,
    onCancelImport: () => void importShareActions.cancelImportPreview(),
    onCancelWebImport: () => importShareModal.setWebImportOpen(false),
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
    onResetSettings: settingsDialog.resetSettings,
    onResolveConfirm: confirmController.resolveConfirmDialog,
    onSelectTranslationSource: (mode) =>
      void importShareActions.selectTranslateSource(mode),
    onPreparedWebImport: importShareActions.acceptWebImportPreview,
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
    webImportOpen: importShareModal.webImportOpen,
  };
}

function createPanelSessionValue(
  model: AppSessionViewModel,
): PanelSessionValue {
  const {
    blockEditingActions,
    panelBridge,
    pointerHandlers,
    settingsDialog,
    uiState,
  } = model;
  return {
    ...buildPanelSyncState(model),
    ...createPanelBlockActions(model),
    editorFloating: uiState.editorFloating,
    editorPoppedOut: panelBridge.openPanelIds.includes("editor"),
    canCreateStylePreset: Boolean(settingsDialog.settings),
    showDetachControls: true,
    onAdjustFontSize: blockEditingActions.adjustSelectedBlockFontSize,
    onApplyFormat: blockEditingActions.applyFormatToScope,
    onApplyStylePreset: blockEditingActions.applyStylePreset,
    onCreateStylePreset: createStylePresetSaveAction(model),
    onDeleteStylePreset: createStylePresetDeleteAction(model),
    onApplyBlockBackgroundOpacity:
      blockEditingActions.applyBlockBackgroundOpacityToScope,
    onToggleEditorFloat: uiState.toggleEditorFloat,
    onBackToPageBlocks: () => uiState.setRightRailMode("page-blocks"),
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
  libraryDrop,
}: AppSessionViewModel): AppSessionViewProps["sidebarProps"] {
  return {
    currentChapter: core.currentChapter,
    jobActive:
      inpaintingBridge.contextValue.jobActive ||
      uiState.translationFlowActive ||
      workspaceHistory.busy ||
      libraryDrop.busy,
    library: core.library,
    lockedPageIds: derivedState.jobTargetPageIds,
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
  libraryDrop,
}: AppSessionViewModel): AppSessionViewProps["workspaceProps"] {
  return {
    ...createWorkspaceViewProps(uiState),
    interactionPreviewStore: pointerHandlers.interactionPreviewStore,
    imageRef: core.imageRef,
    brushColor: uiState.inpaintingPaintColor,
    brushRadius: uiState.inpaintingBrushRadius,
    jobActive:
      derivedState.selectedPageEditLocked ||
      workspaceHistory.busy ||
      libraryDrop.busy,
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
