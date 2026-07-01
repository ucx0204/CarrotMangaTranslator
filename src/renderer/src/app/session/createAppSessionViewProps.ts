import type { useBlockEditingActions } from "../../hooks/useBlockEditingActions";
import type { useConfirmDialog } from "../../hooks/useConfirmDialog";
import type { useImportShareActions } from "../../hooks/useImportShareActions";
import type { useImportShareModalController } from "../../hooks/useImportShareModalController";
import type { useInpaintingActions } from "../../hooks/useInpaintingActions";
import type { useInpaintingContextBridge } from "../../hooks/useInpaintingContextBridge";
import type { useLibraryActions } from "../../hooks/useLibraryActions";
import type { usePageNavigationHandlers } from "../../hooks/usePageNavigationHandlers";
import type { usePageRetranslationAction } from "../../hooks/usePageRetranslationAction";
import type { useSettingsDialog } from "../../hooks/useSettingsDialog";
import type { useStatusLog } from "../../hooks/useStatusLog";
import type { useTranslationActions } from "../../hooks/useTranslationActions";
import type { useWorkspacePointerHandlers } from "../../hooks/useWorkspacePointerHandlers";
import type { PanelSessionValue } from "../../panels/panelSession";
import type { usePanelBridgeHost } from "../../panels/usePanelBridgeHost";
import type { PanelSyncState } from "../../../../shared/panelBridgeTypes";
import type { AppSessionViewProps } from "./AppSessionView";
import type { useAppSessionBridgeActions } from "./useAppSessionBridgeActions";
import type { AppSessionCoreState } from "./useAppSessionCoreState";
import type { useAppSessionDerivedState } from "./useAppSessionDerivedState";
import type { useAppSessionUiState } from "./useAppSessionUiState";
import type { useInpaintingGuidePreference } from "./useInpaintingGuidePreference";

type AppSessionViewModel = {
  blockEditingActions: ReturnType<typeof useBlockEditingActions>;
  bridgeActions: ReturnType<typeof useAppSessionBridgeActions>;
  commands: AppSessionViewProps["commandPaletteProps"]["commands"];
  confirmController: ReturnType<typeof useConfirmDialog>;
  core: AppSessionCoreState;
  derivedState: ReturnType<typeof useAppSessionDerivedState>;
  guidePreference: ReturnType<typeof useInpaintingGuidePreference>;
  importShareActions: ReturnType<typeof useImportShareActions>;
  importShareModal: ReturnType<typeof useImportShareModalController>;
  inpaintingActions: ReturnType<typeof useInpaintingActions>;
  inpaintingBridge: ReturnType<typeof useInpaintingContextBridge>;
  libraryActions: ReturnType<typeof useLibraryActions>;
  panelBridge: ReturnType<typeof usePanelBridgeHost>;
  pageNavigationHandlers: ReturnType<typeof usePageNavigationHandlers>;
  pointerHandlers: ReturnType<typeof useWorkspacePointerHandlers>;
  retranslatePage: ReturnType<typeof usePageRetranslationAction>;
  settingsDialog: ReturnType<typeof useSettingsDialog>;
  statusLog: ReturnType<typeof useStatusLog>;
  translationActions: ReturnType<typeof useTranslationActions>;
  uiState: ReturnType<typeof useAppSessionUiState>;
};

export function createAppSessionViewProps(
  model: AppSessionViewModel,
): AppSessionViewProps {
  return {
    commandPaletteProps: createCommandPaletteProps(model),
    gatherTextProps: createGatherTextProps(model),
    inpaintingContextValue: model.inpaintingBridge.contextValue,
    inpaintingMode: model.uiState.inpaintingMode,
    modalsProps: createModalsProps(model),
    panelSessionValue: createPanelSessionValue(model),
    rightRailProps: createRightRailProps(model),
    shortcutHelpProps: createShortcutHelpProps(model),
    sidebarProps: createSidebarProps(model),
    styleGuideProps: createStyleGuideProps(model),
    translationOptionsProps: createTranslationOptionsProps(model),
    workspaceProps: createWorkspaceProps(model),
  };
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
  uiState,
}: AppSessionViewModel): AppSessionViewProps["gatherTextProps"] {
  return uiState.textViewOpen
    ? {
        chapter: core.currentChapter,
        onChapterUpdated: (chapter) => libraryActions.applyChapter(chapter),
        onClose: () => uiState.setTextViewOpen(false),
        page: derivedState.selectedPage,
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

export function buildPanelSyncState({
  core,
  derivedState,
  uiState,
}: Pick<
  AppSessionViewModel,
  "core" | "derivedState" | "uiState"
>): PanelSyncState {
  return {
    areaTranslateAvailable: Boolean(
      derivedState.selectedPage &&
      derivedState.selectedPageImageDataUrl &&
      !derivedState.jobActive,
    ),
    areaTranslateSelecting: Boolean(core.regionSelection?.active),
    disableChapterApply: derivedState.jobActive,
    editorDisabled:
      derivedState.selectedPageEditLocked ||
      (uiState.inpaintingMode && derivedState.jobActive),
    selectedBlock: derivedState.selectedBlock,
    selectedBlockCount: derivedState.selectedBlockIds.length,
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
  pointerHandlers,
  statusLog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["rightRailProps"] {
  return {
    areaTranslateSelecting: Boolean(core.regionSelection?.active),
    currentChapter: core.currentChapter,
    flowActive: uiState.translationFlowActive,
    inpaintingMode: uiState.inpaintingMode,
    jobActive: derivedState.jobActive,
    jobState: core.jobState,
    onCancelJob: bridgeActions.cancelJob,
    onEnterInpainting: () => void inpaintingActions.enterInpaintingMode(),
    onOpenStyleGuide: () => uiState.setStyleGuideOpen(true),
    onOpenTextView: () => uiState.setTextViewOpen(true),
    onOpenTranslateOptions: () => uiState.setTranslateOptionsOpen(true),
    onStartAreaTranslate: pointerHandlers.startRegionTranslationSelection,
    onToggleBlocks: () => uiState.setShowTextBlocks((value) => !value),
    onToggleChrome: () => uiState.setShowBlockChrome((value) => !value),
    progressSnapshot: derivedState.progressSnapshot,
    selectedBlock: derivedState.selectedBlock,
    selectedPage: derivedState.selectedPage,
    selectedPageImageDataUrl: derivedState.selectedPageImageDataUrl,
    showBlockChrome: uiState.showBlockChrome,
    showProgressBar: derivedState.showProgressBar,
    showTextBlocks: uiState.showTextBlocks,
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
  inpaintingActions,
  libraryActions,
  pageNavigationHandlers,
  retranslatePage,
  settingsDialog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["sidebarProps"] {
  return {
    currentChapter: core.currentChapter,
    inpaintingMode: uiState.inpaintingMode,
    jobActive: derivedState.jobActive,
    library: core.library,
    onExitInpainting: inpaintingActions.exitInpaintingMode,
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

function createTranslationOptionsProps({
  core,
  settingsDialog,
  translationActions,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["translationOptionsProps"] {
  return uiState.translateOptionsOpen && core.currentChapter
    ? {
        chapter: core.currentChapter,
        onClose: () => uiState.setTranslateOptionsOpen(false),
        onPersistDefaults: (patch) => {
          if (settingsDialog.settings) {
            void settingsDialog.saveSettingsQuietly({
              ...settingsDialog.settings,
              ui: { ...settingsDialog.settings.ui, ...patch },
            });
          }
        },
        onStart: (flowOptions) =>
          void translationActions.runTranslationFlow(flowOptions),
        uiSettings: settingsDialog.settings?.ui,
      }
    : null;
}

function createWorkspaceProps({
  blockEditingActions,
  core,
  derivedState,
  importShareActions,
  importShareModal,
  inpaintingBridge,
  pointerHandlers,
  settingsDialog,
  uiState,
}: AppSessionViewModel): AppSessionViewProps["workspaceProps"] {
  return {
    dragHud: pointerHandlers.dragHud,
    imageRef: core.imageRef,
    inpaintingMode: uiState.inpaintingMode,
    inpaintingToolActive: derivedState.inpaintingToolActive,
    jobState: core.jobState,
    maskStrokes: uiState.inpaintingMode ? derivedState.patternMaskStrokes : [],
    onBlockPointerDown: pointerHandlers.onBlockPointerDown,
    onOpenBatchImport: () =>
      void importShareActions.openImportPreview("zip-folder"),
    onOpenSettings: () => void settingsDialog.openSettings(),
    onOpenShareImport: () => void importShareActions.openShareImportPreview(),
    onOpenTranslationSource: () =>
      importShareModal.setTranslationSourceOpen(true),
    onStagePointerDown: pointerHandlers.onStagePointerDown,
    onStagePointerLeave: pointerHandlers.onStagePointerLeave,
    onStagePointerMove: pointerHandlers.onStagePointerMove,
    onStagePointerUp: pointerHandlers.onStagePointerUp,
    onToggleBlockExcluded: blockEditingActions.toggleBlockInpaintExcluded,
    progressSnapshot: derivedState.progressSnapshot,
    regionSelectionActive: Boolean(core.regionSelection?.active),
    regionSelectionRect: derivedState.regionSelectionRect,
    retouchCursor: inpaintingBridge.retouchCursor,
    retouchPreviewLayer: inpaintingBridge.retouchPreviewLayer,
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
    workspacePanelRef: core.workspacePanelRef,
    workspaceZoom: uiState.workspaceZoom,
  };
}
