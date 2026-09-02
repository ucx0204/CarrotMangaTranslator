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
  createBlockLibraryProps,
  createCommandPaletteProps,
  createShortcutHelpProps,
} from "./createAppOverlayProps";
import { createPanelBlockActions } from "./createPanelBlockActions";
import { createRightRailProps } from "./createRightRailProps";
import {
  createStylePresetOverwriteAction,
  createStylePresetRenameAction,
  createStylePresetSaveAction,
} from "./createStylePresetSaveAction";
import { createStylePresetDeleteAction } from "./createStylePresetDeleteAction";
import { openManualErrorReport } from "../../lib/errorReportStore";
import { createModalCloseActions } from "./createModalCloseActions";
import { pickPanelFormatPatch } from "../../../../shared/panelBridgeTypes";
import { createConditionalBatchEditorProps } from "./createConditionalBatchEditorProps";
import {
  createSoundEffectTranslationLauncherProps,
  createSoundEffectTranslationModalProps,
} from "./createSoundEffectReviewViewProps";
import { createWorkspaceProps } from "./createWorkspaceProps";

export function createAppSessionViewProps(model: AppSessionViewModel) {
  const workspaceProps = createWorkspaceProps(model);
  return {
    autoInpaintingOptionsProps: createAutoInpaintingOptionsProps(model),
    blockLibraryProps: createBlockLibraryProps(model),
    commandPaletteProps: createCommandPaletteProps(model),
    conditionalBatchEditorProps: createConditionalBatchEditorProps(
      model,
      workspaceProps,
    ),
    exportOptionsProps: createExportOptionsProps(model),
    gatherTextProps: createGatherTextProps(model),
    libraryDropOverlayProps: model.libraryDrop,
    modalsProps: createModalsProps(model),
    pageRetranslateProps: createPageRetranslateProps(model),
    panelSessionValue: createPanelSessionValue(model),
    rightRailProps: createRightRailProps(model),
    shortcutHelpProps: createShortcutHelpProps(model),
    sidebarProps: createSidebarProps(model),
    soundEffectLauncherProps: createSoundEffectTranslationLauncherProps(model),
    soundEffectTranslationModalProps:
      createSoundEffectTranslationModalProps(model),
    styleGuideProps: createStyleGuideProps(model),
    translationOptionsProps: createTranslationOptionsProps(model),
    workspaceProps,
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
        kind: uiState.exportOptionsKind,
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
        onStart:
          uiState.exportOptionsKind === "psd"
            ? inpaintingActions.exportPagePsd
            : inpaintingActions.exportPageImages,
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
  operationActivity,
}: AppSessionViewModel): AppSessionViewProps["modalsProps"] {
  return {
    ...createModalCloseActions({
      guidePreference,
      importShareActions,
      importShareModal,
      libraryActions,
      settingsDialog,
    }),
    confirmDialog: confirmController.confirmDialog,
    currentWorkId: core.currentChapter?.workId ?? null,
    importBusy: importShareModal.importBusy || libraryDrop.busy,
    importPreview: importShareModal.importModalOpen
      ? importShareModal.importPreview
      : null,
    importDraft: importShareModal.importDraft,
    importFeedback: importShareModal.importFeedback,
    inpaintingGuideOpen: uiState.inpaintingGuideOpen,
    fontManagerOpen: uiState.fontManagerOpen,
    jobActive:
      derivedState.jobActive ||
      operationActivity.active ||
      importShareModal.importBusy,
    library: core.library,
    onWebImportBackgroundStateChange: importShareModal.setWebImportBackgrounded,
    onDeleteRename: () => void libraryActions.deleteRenameTarget(),
    onOpenLogFolder: bridgeActions.openLogFolder,
    onOpenErrorReport: openManualErrorReport,
    onCloseFontManager: () => uiState.setFontManagerOpen(false),
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
    settingsOpenRequest: settingsDialog.openRequest,
    shareExportBusy: importShareModal.shareExportBusy,
    shareExportDraft: importShareModal.shareExportDraft,
    shareExportOpen: importShareModal.shareExportOpen,
    shareImportBusy: importShareModal.shareImportBusy,
    shareImportDraft: importShareModal.shareImportDraft,
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
    onAdjustFontSize: blockEditingActions.adjustSelectedBlocksFontSize,
    onApplyFormat: blockEditingActions.applyFormatToScope,
    onApplyStylePreset: blockEditingActions.applyStylePreset,
    onCreateStylePreset: createStylePresetSaveAction(model),
    onDeleteStylePreset: createStylePresetDeleteAction(model),
    onOpenStylePresetManager: () =>
      void settingsDialog.openSettings("style-presets"),
    onOpenFontManager: () => uiState.setFontManagerOpen(true),
    onOverwriteStylePreset: createStylePresetOverwriteAction(model),
    onRenameStylePreset: createStylePresetRenameAction(model),
    onApplyBlockBackgroundOpacity:
      blockEditingActions.applyBlockBackgroundOpacityToScope,
    onToggleEditorFloat: uiState.toggleEditorFloat,
    onBackToPageBlocks: () => uiState.setRightRailMode("page-blocks"),
    onPopOutEditor: panelBridge.openEditorWindow,
    onDockEditorWindow: panelBridge.closeEditorWindow,
    onDeleteBlock: blockEditingActions.deleteSelectedBlock,
    onDuplicateBlock: blockEditingActions.duplicateSelectedBlock,
    onOpenBlockLibrary: () => uiState.setBlockLibraryOpen(true),
    onSuggestConsistentEdit: (find, replace) => {
      uiState.setConditionalBatchInitialFind(find);
      uiState.setConditionalBatchInitialReplace(replace);
      uiState.setConditionalBatchOpen(true);
    },
    onInsertBlockLibraryEntry: blockEditingActions.insertBlockLibraryEntry,
    onRemoveBubbleLayout: blockEditingActions.removeSelectedBlockBubbleLayout,
    onSelectTransformMode: (mode) => {
      uiState.selectWorkspaceTool(mode);
    },
    onStartAreaTranslate: pointerHandlers.startRegionTranslationSelection,
    onUpdateBlock: blockEditingActions.updateSelectedBlock,
    onUpdateFormat: (patch) =>
      blockEditingActions.updateSelectedBlocks(pickPanelFormatPatch(patch)),
  };
}

function createSidebarProps({
  commandRegistry,
  core,
  derivedState,
  importShareModal,
  inpaintingBridge,
  libraryActions,
  pageNavigationHandlers,
  retranslatePage,
  settingsDialog,
  uiState,
  workspaceHistory,
  libraryDrop,
  operationActivity,
}: AppSessionViewModel): AppSessionViewProps["sidebarProps"] {
  const ordinaryJobActive = [
    derivedState.jobActive,
    uiState.translationFlowActive,
    workspaceHistory.busy,
    libraryDrop.busy,
  ].some(Boolean);
  return {
    commandLabels: commandRegistry.labels,
    currentChapter: core.currentChapter,
    jobActive: [
      inpaintingBridge.contextValue.jobActive,
      uiState.translationFlowActive,
      workspaceHistory.busy,
      libraryDrop.busy,
      operationActivity.active,
      importShareModal.importBusy,
    ].some(Boolean),
    libraryMutationBlocked: [
      ordinaryJobActive,
      operationActivity.libraryMutationBlocked,
      importShareModal.importBusy,
    ].some(Boolean),
    library: core.library,
    lockedPageIds: derivedState.jobTargetPageIds,
    onOpenBatchImport: commandRegistry.byId["open-batch"].run,
    onOpenChapter: (chapterId) => void libraryActions.openChapter(chapterId),
    onOpenLibraryFolder: commandRegistry.byId["open-library-folder"].run,
    onOpenSettings: commandRegistry.byId["open-settings"].run,
    onOpenShareExport: commandRegistry.byId["open-share-export"].run,
    onOpenShareImport: commandRegistry.byId["open-share-import"].run,
    onOpenTranslationSource: commandRegistry.byId["open-translate-source"].run,
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
  const currentWork = core.library.works.find(
    (work) => work.id === core.currentChapter?.workId,
  );
  return uiState.styleGuideOpen && core.currentChapter
    ? {
        chapter: core.currentChapter,
        jobActive: derivedState.jobActive,
        workTitle: currentWork?.title ?? "",
        onClose: () => uiState.setStyleGuideOpen(false),
        onBackgroundStateChange: uiState.setStyleGuideBackgrounded,
        onSaveSettings: settingsDialog.saveSettingsQuietly,
        settings: settingsDialog.settings,
      }
    : null;
}
