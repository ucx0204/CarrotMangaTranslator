import { useBlockEditingActions } from "../../hooks/useBlockEditingActions";
import { useCurrentChapterUpdater } from "../../hooks/useCurrentChapterUpdater";
import { useImportShareActions } from "../../hooks/useImportShareActions";
import { usePageRetranslationAction } from "../../hooks/usePageRetranslationAction";
import { useRegionTranslationPreparation } from "../../hooks/useRegionTranslationPreparation";
import { useTranslationActions } from "../../hooks/useTranslationActions";
import type { ChapterSessionController } from "./useChapterSessionController";

export function useTranslationController(chapter: ChapterSessionController) {
  const importShareActions = useImportShareController(chapter);
  const translationActions = useTranslationActionController(chapter);
  const updateCurrentChapter = useCurrentChapterUpdater({
    currentChapterRef: chapter.core.currentChapterRef,
    markDirty: chapter.persistence.markDirty,
    setCurrentChapter: chapter.core.setCurrentChapter,
  });
  const retranslatePage = usePageRetranslationAction({
    askConfirm: chapter.confirmController.askConfirm,
    currentChapter: chapter.core.currentChapter,
    runAnalysis: translationActions.runAnalysis,
  });
  const blockEditingActions = useBlockEditingActions({
    currentChapter: chapter.core.currentChapter,
    currentChapterRef: chapter.core.currentChapterRef,
    jobActive: chapter.derivedState.jobActive,
    markDirty: chapter.persistence.markDirty,
    pushStatus: chapter.statusLog.pushStatus,
    selectedBlock: chapter.derivedState.selectedBlock,
    selectedPage: chapter.derivedState.selectedPage,
    selectedPageEditLocked: chapter.derivedState.selectedPageEditLocked,
    setCurrentChapter: chapter.core.setCurrentChapter,
    setSelectedBlockId: chapter.core.setSelectedBlockId,
    updateCurrentChapter,
  });

  return {
    blockEditingActions,
    importShareActions,
    retranslatePage,
    translationActions,
    updateCurrentChapter,
  };
}

export type TranslationController = ReturnType<typeof useTranslationController>;

function useImportShareController(chapter: ChapterSessionController) {
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
  });
}

function useTranslationActionController(chapter: ChapterSessionController) {
  const prepareRegionTranslation = useRegionTranslationPreparation({
    inpaintingMode: chapter.uiState.inpaintingMode,
    pushStatus: chapter.statusLog.pushStatus,
  });

  return useTranslationActions({
    beforeTranslateRegion: prepareRegionTranslation,
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
    setCurrentChapter: chapter.core.setCurrentChapter,
    setFlowActive: chapter.uiState.setTranslationFlowActive,
    setJobState: chapter.core.setJobState,
    setSelectedBlockId: chapter.core.setSelectedBlockId,
  });
}
