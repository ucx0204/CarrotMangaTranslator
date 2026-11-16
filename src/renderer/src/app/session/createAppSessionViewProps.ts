import { publishTextSelectionPreview } from "../../lib/textSelectionPreview";
import { activityResourcesConflict } from "../../../../shared/appActivityTypes";
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
  createExportOptionsProps,
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
    rightRailProps: {
      ...createRightRailProps(model),
      commandLabels: model.commandRegistry.labels,
      onOpenChat: model.commandRegistry.byId["open-chat"].run,
      onOpenExport: model.commandRegistry.byId["open-export-options"].run,
      onOpenPsdExport:
        model.commandRegistry.byId["open-psd-export-options"].run,
      onChatPage: (chapterId: string, pageId: string) => {
        void (async () => {
          if (model.core.currentChapter?.id !== chapterId)
            await model.libraryActions.openChapter(chapterId);
          if (model.core.currentChapterRef.current?.id === chapterId)
            model.pageNavigationHandlers.selectPageForReading(pageId);
        })().catch((error: unknown) =>
          model.statusLog.pushStatus(String(error)),
        );
      },
    },
    shortcutHelpProps: createShortcutHelpProps(model),
    sidebarProps: createSidebarProps(model),
    soundEffectLauncherProps: createSoundEffectTranslationLauncherProps(model),
    soundEffectTranslationModalProps:
      createSoundEffectTranslationModalProps(model),
    styleGuideProps: createStyleGuideProps(model),
    translationOptionsProps: createTranslationOptionsProps(model),
    redactionPreparationProps: model.uiState.redactionPreparationRequest
      ? {
          request: model.uiState.redactionPreparationRequest,
          beforeOpen: model.persistence.saveNow,
          onClose: () => model.uiState.setRedactionPreparationRequest(null),
        }
      : null,
    regionTranslationProps:
      model.translationActions.regionTranslationDialog ?? null,
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
    ...createModalCloseActions({
      guidePreference,
      importShareActions,
      importShareModal,
      libraryActions,
      settingsDialog,
    }),
    confirmDialog: confirmController.confirmDialog,
    currentWorkId: core.currentChapter?.workId ?? null,
    currentChapterId: core.currentChapter?.id ?? null,
    importBusy: importShareModal.importBusy || libraryDrop.busy,
    importPreview: importShareModal.importModalOpen
      ? importShareModal.importPreview
      : null,
    importDraft: importShareModal.importDraft,
    importFeedback: importShareModal.importFeedback,
    inpaintingGuideOpen: uiState.inpaintingGuideOpen,
    fontManagerOpen: uiState.fontManagerOpen,
    jobActive: derivedState.modelResourceBusy,
    library: core.library,
    onWebImportBackgroundStateChange: importShareModal.setWebImportBackgrounded,
    onOpenLogFolder: bridgeActions.openLogFolder,
    onOpenModelFolder: bridgeActions.openModelFolder,
    onOpenErrorReport: openManualErrorReport,
    onCloseFontManager: () => uiState.setFontManagerOpen(false),
    onResetSettings: settingsDialog.resetSettings,
    onResolveConfirm: confirmController.resolveConfirmDialog,
    onSelectTranslationSource: (mode) =>
      void importShareActions.selectTranslateSource(mode),
    onPreparedWebImport: importShareActions.acceptWebImportPreview,
    onSubmitImport: (payload) => void importShareActions.submitImport(payload),
    onSubmitRename: (title, moveResultFolders) =>
      void libraryActions.submitRename(title, moveResultFolders),
    onSubmitSettings: (nextSettings) =>
      void settingsDialog.submitSettings(nextSettings),
    onSubmitShareExport: (request) =>
      void importShareActions.submitShareExport(request),
    onSubmitShareImport: (payload) =>
      void importShareActions.submitShareImport(payload),
    pageEditor: libraryActions.pageEditor,
    renameBusy: libraryActions.renameBusy,
    renameTarget: libraryActions.renameTarget,
    settings: settingsDialog.settings,
    settingsBusy: settingsDialog.settingsBusy,
    settingsOpen: settingsDialog.settingsOpen,
    settingsOpenRequest: settingsDialog.openRequest,
    settingsRecovery: {
      failure: settingsDialog.settingsFailure,
      onRetry: () => void settingsDialog.openSettings(),
      onRecover: () => void settingsDialog.recoverCredentials(),
    },
    shareExportBusy: importShareModal.shareExportBusy,
    shareExportDraft: importShareModal.shareExportDraft,
    shareExportOpen: importShareModal.shareExportOpen,
    shareImportBusy: importShareModal.shareImportBusy,
    shareImportDraft: importShareModal.shareImportDraft,
    shareImportPreview: importShareModal.shareImportPreview,
    translationSourceOpen: importShareModal.translationSourceOpen,
    addPagesChapter: importShareModal.addPagesChapter,
    onClearAddPages: () => importShareModal.setAddPagesChapter(null),
    webImportOpen: importShareModal.webImportOpen,
  };
}

function createPanelSessionValue(
  model: AppSessionViewModel,
): PanelSessionValue {
  const { blockEditingActions, panelBridge, settingsDialog, uiState } = model;
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
    onChangeLetteringTool: (tool) => {
      uiState.selectWorkspaceTool("select");
      uiState.setLetteringTool(tool);
    },
    onSelectTransformMode: (mode) => {
      uiState.selectWorkspaceTool(mode);
    },
    onStartAreaTranslate: model.commandRegistry.byId["translate-region"].run,
    onUpdateBlock: blockEditingActions.updateSelectedBlock,
    onPreviewTextSelection: publishTextSelectionPreview,
    onUpdateFormat: (patch) =>
      blockEditingActions.updateSelectedBlocks(pickPanelFormatPatch(patch)),
  };
}

function createSidebarProps({
  commandRegistry,
  core,
  derivedState,
  libraryActions,
  linkedWorkspace,
  pageNavigationHandlers,
  retranslatePage,
  settingsDialog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["sidebarProps"] {
  return {
    chatOpen: uiState.chatOpen,
    commandLabels: commandRegistry.labels,
    currentChapter: core.currentChapter,
    jobActive: false,
    libraryMutationBlocked: false,
    pageStructureBlocked: derivedState.chapterStructureLocked,
    library: core.library,
    lockedPageIds: derivedState.editingLockedPageIds,
    removalLockedPageIds: derivedState.removalLockedPageIds,
    translationBlocked: derivedState.translationModelBusy,
    onOpenBatchImport: commandRegistry.byId["open-batch"].run,
    onOpenChat: commandRegistry.byId["open-chat"].run,
    onOpenChapter: (chapterId) => void libraryActions.openChapter(chapterId),
    onOpenLibraryFolder: commandRegistry.byId["open-library-folder"].run,
    onOpenSettings: commandRegistry.byId["open-settings"].run,
    onOpenShareExport: commandRegistry.byId["open-share-export"].run,
    onOpenShareImport: commandRegistry.byId["open-share-import"].run,
    onOpenTranslationSource: commandRegistry.byId["open-translate-source"].run,
    onEditPages: commandRegistry.byId["edit-pages"].run,
    onAddChapterPages: commandRegistry.byId["add-chapter-pages"].run,
    onRemovePage: (pageId) => void libraryActions.removePage(pageId),
    onRenameChapter: (chapterId) =>
      void libraryActions.renameChapter(chapterId),
    onRenameWork: (workId) => void libraryActions.renameWork(workId),
    contextActions: {
      selection: libraryActions.chapterBulkDelete,
      openContext: uiState.openWorkContext,
      deleteTarget: (target) => void libraryActions.deleteRenameTarget(target),
      results: linkedWorkspace,
    },
    organizeAllResults: {
      ...commandRegistry.byId["organize-all-linked-results"],
      busy: linkedWorkspace.isOrganizing(),
    },
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
    (work) =>
      work.id === (uiState.styleGuideWorkId ?? core.currentChapter?.workId),
  );
  return uiState.styleGuideOpen && currentWork
    ? {
        chapter:
          core.currentChapter?.workId === currentWork.id
            ? core.currentChapter
            : null,
        workId: currentWork.id,
        jobActive: derivedState.activities
          ? derivedState.activities.activities.some((activity) =>
              activityResourcesConflict(
                [
                  {
                    kind: "work-context",
                    scope: currentWork.id,
                    access: "write",
                  },
                ],
                activity.resources,
              ),
            )
          : derivedState.modelResourceBusy,
        workTitle: currentWork?.title ?? "",
        onClose: () => uiState.setStyleGuideOpen(false),
        onBackgroundStateChange: uiState.setStyleGuideBackgrounded,
        onSaveSettings: settingsDialog.saveSettingsQuietly,
        settings: settingsDialog.settings,
      }
    : null;
}
