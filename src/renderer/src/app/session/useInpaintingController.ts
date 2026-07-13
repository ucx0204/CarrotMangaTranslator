import { useAppSessionCommandController } from "./useAppSessionCommandController";
import { useAppSessionInpaintingController } from "./useAppSessionInpaintingController";
import type { ChapterSessionController } from "./useChapterSessionController";
import type { TranslationController } from "./useTranslationController";

export function useInpaintingController(
  chapter: ChapterSessionController,
  translation: TranslationController,
) {
  const inpainting = useAppSessionInpaintingController({
    askConfirm: chapter.confirmController.askConfirm,
    blockFormatDefaults: chapter.settingsDialog.settings?.blockFormatDefaults,
    bridgeActions: chapter.bridgeActions,
    core: chapter.core,
    derivedState: chapter.derivedState,
    dirty: chapter.persistence.dirty,
    mergeLiveChapter: chapter.mergeLiveChapter,
    modalOpen: chapter.modalOpen,
    pushStatus: chapter.statusLog.pushStatus,
    refreshLibrary: chapter.libraryActions.refreshLibrary,
    saveNow: chapter.persistence.saveNow,
    translateSelectedRegion:
      translation.translationActions.translateSelectedRegion,
    uiState: chapter.uiState,
    updateCurrentChapter: translation.updateCurrentChapter,
  });
  const commands = useAppSessionCommandController({
    autoInpaintingOpen: chapter.uiState.autoInpaintingOpen,
    cancelJob: chapter.bridgeActions.cancelJob,
    currentChapter: chapter.core.currentChapter,
    jobActive: chapter.derivedState.jobActive,
    openImportPreview: translation.importShareActions.openImportPreview,
    openLibraryFolder: chapter.bridgeActions.openLibraryFolder,
    openLogFolder: chapter.bridgeActions.openLogFolder,
    openSettings: chapter.settingsDialog.openSettings,
    openShareImportPreview:
      translation.importShareActions.openShareImportPreview,
    runAnalysis: (runMode) =>
      void translation.translationActions.runAnalysis(runMode),
    setShareExportOpen: chapter.importShareModal.setShareExportOpen,
    setShortcutHelpOpen: chapter.uiState.setShortcutHelpOpen,
    setTextViewOpen: chapter.uiState.setTextViewOpen,
    setTranslateOptionsOpen: chapter.uiState.setTranslateOptionsOpen,
    setTranslationSourceOpen: chapter.importShareModal.setTranslationSourceOpen,
    toggleAutoInpainting: chapter.uiState.toggleAutoInpainting,
  });

  return {
    commands,
    ...inpainting,
  };
}

export type InpaintingController = ReturnType<typeof useInpaintingController>;
