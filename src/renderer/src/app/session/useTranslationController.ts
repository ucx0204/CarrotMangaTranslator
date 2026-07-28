import { useBlockEditingActions } from "../../hooks/useBlockEditingActions";
import { useCurrentChapterUpdater } from "../../hooks/useCurrentChapterUpdater";
import { useImportShareActions } from "../../hooks/useImportShareActions";
import { usePageRetranslationAction } from "../../hooks/usePageRetranslationAction";
import { useRegionTranslationPreparation } from "../../hooks/useRegionTranslationPreparation";
import { useTranslationActions } from "../../hooks/useTranslationActions";
import type { ChapterSessionController } from "./useChapterSessionController";
import { useAppSessionWorkspaceHistory } from "./useAppSessionWorkspaceHistory";

export function useTranslationController(
  chapter: ChapterSessionController,
  clearRetouchHistory: () => void,
) {
  const workspaceHistory = useAppSessionWorkspaceHistory(chapter);
  const importShareActions = useImportShareController(
    chapter,
    workspaceHistory.reset,
  );
  const translationActions = useTranslationActionController(
    chapter,
    workspaceHistory,
    clearRetouchHistory,
  );
  const updateCurrentChapter = useCurrentChapterUpdater({
    currentChapterRef: chapter.core.currentChapterRef,
    markDirty: chapter.persistence.markDirty,
    setCurrentChapter: chapter.core.setCurrentChapter,
    selection: {
      selectedPageId: chapter.core.selectedPageId,
      selectedBlockId: chapter.core.selectedBlockId,
      selectedBlockIds: chapter.core.selectedBlockIds,
    },
    workspaceHistory,
  });
  const retranslatePage = usePageRetranslationAction({
    askConfirm: chapter.confirmController.askConfirm,
    currentChapter: chapter.core.currentChapter,
    openRetranslateOptions: chapter.uiState.setRetranslatePageId,
    runAnalysis: translationActions.runAnalysis,
  });
  const blockEditingActions = useBlockEditingActions({
    currentChapter: chapter.core.currentChapter,
    jobActive:
      chapter.derivedState.jobActive ||
      chapter.uiState.translationFlowActive ||
      workspaceHistory.busy,
    pushStatus: chapter.statusLog.pushStatus,
    selectedBlock: chapter.derivedState.selectedBlock,
    selectedBlockIds: chapter.derivedState.selectedBlockIds,
    selectedPage: chapter.derivedState.selectedPage,
    selectedPageEditLocked:
      chapter.derivedState.selectedPageEditLocked ||
      chapter.uiState.translationFlowActive ||
      workspaceHistory.busy,
    setSelectedBlockId: chapter.core.setSelectedBlockId,
    setSelectedBlockIds: chapter.core.setSelectedBlockIds,
    updateCurrentChapter,
  });

  return {
    blockEditingActions,
    importShareActions,
    retranslatePage,
    translationActions,
    updateCurrentChapter,
    workspaceHistory,
  };
}

export type TranslationController = ReturnType<typeof useTranslationController>;

function useImportShareController(
  chapter: ChapterSessionController,
  resetWorkspaceHistory: () => void,
) {
  return useImportShareActions({
    applyChapter: chapter.libraryActions.applyChapter,
    askConfirm: chapter.confirmController.askConfirm,
    dirty: chapter.persistence.dirty,
    importPreview: chapter.importShareModal.importPreview,
    mergeLiveChapter: chapter.mergeLiveChapter,
    openChapter: chapter.libraryActions.openChapter,
    pushStatus: chapter.statusLog.pushStatus,
    refreshLibrary: chapter.libraryActions.refreshLibrary,
    saveNow: chapter.persistence.saveNow,
    setImportBusy: chapter.importShareModal.setImportBusy,
    setImportPreview: chapter.importShareModal.setImportPreview,
    setShareExportBusy: chapter.importShareModal.setShareExportBusy,
    setShareExportOpen: chapter.importShareModal.setShareExportOpen,
    setShareImportBusy: chapter.importShareModal.setShareImportBusy,
    setShareImportPreview: chapter.importShareModal.setShareImportPreview,
    setTranslationSourceOpen: chapter.importShareModal.setTranslationSourceOpen,
    shareImportPreview: chapter.importShareModal.shareImportPreview,
    resetWorkspaceHistory,
  });
}

function useTranslationActionController(
  chapter: ChapterSessionController,
  workspaceHistory: ReturnType<typeof useAppSessionWorkspaceHistory>,
  clearRetouchHistory: () => void,
) {
  const prepareRegionTranslation = useRegionTranslationPreparation({
    pushStatus: chapter.statusLog.pushStatus,
  });
  const uiDefaults = chapter.settingsDialog.settings?.ui ?? {};

  return useTranslationActions({
    beforeTranslate: async () => {
      workspaceHistory.reset();
      await prepareRegionTranslation();
    },
    clearPageImageCache: chapter.derivedState.clearPageImageCache,
    clearRetouchHistory,
    clearStatusLines: chapter.statusLog.clearStatusLines,
    currentChapter: chapter.core.currentChapter,
    currentChapterRef: chapter.core.currentChapterRef,
    jobActive: chapter.derivedState.jobActive,
    library: chapter.core.library,
    mergeLiveChapter: chapter.mergeLiveChapter,
    pushStatus: chapter.statusLog.pushStatus,
    refreshLibrary: chapter.libraryActions.refreshLibrary,
    saveNow: chapter.persistence.saveNow,
    selectedPage: chapter.derivedState.selectedPage,
    translationWorkflowDefault:
      uiDefaults.translationWorkflowDefault ?? "cumulative",
    analysisScopeDefault: uiDefaults.analysisScopeDefault ?? "missing",
    blockModeDefault: uiDefaults.blockModeDefault ?? "auto",
    naturalTextLayoutDefault: uiDefaults.naturalTextLayoutDefault ?? true,
    recordImageEdit: workspaceHistory.recordImageEdit,
    setCurrentChapter: chapter.core.setCurrentChapter,
    setFlowActive: chapter.uiState.setTranslationFlowActive,
    setShowBlockChrome: chapter.uiState.setShowBlockChrome,
    setJobState: chapter.core.setJobState,
    setSelectedBlockId: chapter.core.setSelectedBlockId,
    syncSavedPageVersion: chapter.persistence.syncSavedPageVersion,
  });
}
