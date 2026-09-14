import { useCodexConnection } from "../../hooks/useCodexConnection";
import { canUseCodexImages } from "../../../../shared/codexCapabilities";
import { useAppSessionCommandController } from "./useAppSessionCommandController";
import { useAppSessionInpaintingController } from "./useAppSessionInpaintingController";
import type { ChapterSessionController } from "./useChapterSessionController";
import type { TranslationController } from "./useTranslationController";
import { openErrorReport } from "../../lib/errorReportStore";
import { activityResourcesConflict } from "../../../../shared/appActivityTypes";

export function useInpaintingController(
  chapter: ChapterSessionController,
  translation: TranslationController,
) {
  const { account } = useCodexConnection(true);
  const inpainting = useAppSessionInpaintingController({
    codexErasureBusy: isCodexErasureBusy(chapter, translation),
    codexErasureAvailable: canUseCodexImages(
      chapter.settingsDialog.settings,
      account,
    ),
    askConfirm: chapter.confirmController.askConfirm,
    blockFormatDefaults: chapter.settingsDialog.settings?.blockFormatDefaults,
    bridgeActions: chapter.bridgeActions,
    core: chapter.core,
    derivedState: chapter.derivedState,
    dirty: chapter.persistence.dirty,
    exclusiveActivityActive:
      chapter.operationActivity.active || chapter.importShareModal.importBusy,
    mergeLiveChapter: chapter.mergeLiveChapter,
    modalOpen:
      chapter.modalOpen ||
      Boolean(translation.translationActions.regionTranslationDialog),
    pushStatus: chapter.statusLog.pushStatus,
    refreshLibrary: chapter.libraryActions.refreshLibrary,
    saveNow: chapter.persistence.saveNow,
    savePageNow: chapter.persistence.savePageNow,
    translateSelectedRegion:
      translation.translationActions.translateSelectedRegion,
    uiState: chapter.uiState,
    updateCurrentChapter: translation.updateCurrentChapter,
    workspaceHistory: translation.workspaceHistory,
  });
  const commandRegistry = useSessionCommands(chapter, translation, inpainting);

  return { commandRegistry, ...inpainting };
}

function useSessionCommands(
  chapter: ChapterSessionController,
  translation: TranslationController,
  inpainting: ReturnType<typeof useAppSessionInpaintingController>,
) {
  return useAppSessionCommandController({
    redactionPreparation: {
      currentPageId: chapter.derivedState.selectedPage?.id ?? null,
      open: chapter.uiState.setRedactionPreparationRequest,
    },
    aiUnavailable: inpainting.inpaintingBridge.contextValue.aiUnavailable,
    startRegionTranslation:
      inpainting.pointerHandlers.startRegionTranslationSelection,
    cancelJob: () =>
      chapter.operationActivity.active
        ? void chapter.operationActivity.cancel()
        : chapter.bridgeActions.cancelJob(),
    currentChapter: chapter.core.currentChapter,
    jobActive:
      chapter.derivedState.modelResourceBusy ||
      chapter.uiState.translationFlowActive ||
      translation.workspaceHistory.busy ||
      Boolean(chapter.uiState.redactionPreparationRequest),
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
    openTextView: () => chapter.uiState.openTextView(),
    setShowBlockChrome: chapter.uiState.setShowBlockChrome,
    setShowTextBlocks: chapter.uiState.setShowTextBlocks,
    openTranslateOptions: chapter.uiState.openTranslateOptions,
    setTranslationSourceOpen: chapter.importShareModal.setTranslationSourceOpen,
  });
}

export type InpaintingController = ReturnType<typeof useInpaintingController>;

function isCodexErasureBusy(
  chapter: ChapterSessionController,
  translation: TranslationController,
): boolean {
  const settings = chapter.settingsDialog.settings;
  return (
    !settings ||
    chapter.derivedState.selectedPageEditLocked ||
    translation.workspaceHistory.busy ||
    Boolean(
      settings.inpainting?.bubbleLayoutAfterInpainting &&
      chapter.derivedState.modelResourceBusy,
    ) ||
    Boolean(
      chapter.derivedState.activities?.activities.some((activity) =>
        activityResourcesConflict(
          [{ kind: "codex-auth", scope: "*", access: "read" }],
          activity.resources,
        ),
      ),
    )
  );
}
