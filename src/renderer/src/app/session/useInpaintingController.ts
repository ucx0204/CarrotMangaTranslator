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
    bridgeActions: chapter.bridgeActions,
    core: chapter.core,
    derivedState: chapter.derivedState,
    dirty: chapter.persistence.dirty,
    hideInpaintingGuide: chapter.guidePreference.hideInpaintingGuide,
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
    blockingModalOpen: chapter.overlayModalsOpen,
    cancelJob: chapter.bridgeActions.cancelJob,
    commandPaletteOpen: chapter.uiState.commandPaletteOpen,
    currentChapter: chapter.core.currentChapter,
    enterInpaintingMode: inpainting.inpaintingActions.enterInpaintingMode,
    exitInpaintingMode: inpainting.inpaintingActions.exitInpaintingMode,
    inpaintingMode: chapter.uiState.inpaintingMode,
    jobActive: chapter.derivedState.jobActive,
    openImportPreview: translation.importShareActions.openImportPreview,
    openLibraryFolder: chapter.bridgeActions.openLibraryFolder,
    openLogFolder: chapter.bridgeActions.openLogFolder,
    openSettings: chapter.settingsDialog.openSettings,
    openShareImportPreview:
      translation.importShareActions.openShareImportPreview,
    runAnalysis: (runMode) =>
      void translation.translationActions.runAnalysis(runMode),
    setCommandPaletteOpen: chapter.uiState.setCommandPaletteOpen,
    setShareExportOpen: chapter.importShareModal.setShareExportOpen,
    setShortcutHelpOpen: chapter.uiState.setShortcutHelpOpen,
    setTextViewOpen: chapter.uiState.setTextViewOpen,
    setTranslateOptionsOpen: chapter.uiState.setTranslateOptionsOpen,
    setTranslationSourceOpen: chapter.importShareModal.setTranslationSourceOpen,
  });

  return {
    commands,
    ...inpainting,
  };
}

export type InpaintingController = ReturnType<typeof useInpaintingController>;
