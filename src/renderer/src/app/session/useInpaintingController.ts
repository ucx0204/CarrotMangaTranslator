import { useAppSessionCommandController } from "./useAppSessionCommandController";
import { useAppSessionInpaintingController } from "./useAppSessionInpaintingController";
import type { ChapterSessionController } from "./useChapterSessionController";
import type { TranslationController } from "./useTranslationController";
import { openErrorReport } from "../../lib/errorReportStore";

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
    workspaceHistory: translation.workspaceHistory,
  });
  const commands = useAppSessionCommandController({
    cancelJob: chapter.bridgeActions.cancelJob,
    currentChapter: chapter.core.currentChapter,
    jobActive:
      inpainting.inpaintingBridge.contextValue.jobActive ||
      chapter.uiState.translationFlowActive ||
      translation.workspaceHistory.busy,
    openImportPreview: translation.importShareActions.openImportPreview,
    openLibraryFolder: chapter.bridgeActions.openLibraryFolder,
    openLogFolder: chapter.bridgeActions.openLogFolder,
    openErrorReport: () =>
      openErrorReport({ source: "manual" }, { force: true }),
    openSettings: chapter.settingsDialog.openSettings,
    openShareImportPreview:
      translation.importShareActions.openShareImportPreview,
    runAnalysis: (runMode) =>
      void translation.translationActions.runAnalysis(runMode),
    runCurrentPageInpainting: () => {
      chapter.core.setRegionSelection(null);
      chapter.uiState.selectWorkspaceTool("select");
      chapter.uiState.setPeekOriginal(false);
      chapter.uiState.setAutoInpaintingEntryScope("select");
      chapter.uiState.setAutoInpaintingOptionsOpen(true);
    },
    setShareExportOpen: chapter.importShareModal.setShareExportOpen,
    setShortcutHelpOpen: chapter.uiState.setShortcutHelpOpen,
    openTextView: () => chapter.uiState.openTextView("overview"),
    setShowBlockChrome: chapter.uiState.setShowBlockChrome,
    setShowTextBlocks: chapter.uiState.setShowTextBlocks,
    openTranslateOptions: chapter.uiState.openTranslateOptions,
    setTranslationSourceOpen: chapter.importShareModal.setTranslationSourceOpen,
  });

  return {
    commands,
    ...inpainting,
  };
}

export type InpaintingController = ReturnType<typeof useInpaintingController>;
