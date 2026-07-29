import { useChapterPersistence } from "../../hooks/useChapterPersistence";
import { useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useJobEvents } from "../../hooks/useJobEvents";
import { useLibraryActions } from "../../hooks/useLibraryActions";
import { useLiveChapterSync } from "../../hooks/useLiveChapterSync";
import { useStatusLog } from "../../hooks/useStatusLog";
import { toast } from "../../lib/toastStore";
import {
  openErrorReport,
  useErrorReportIncident,
} from "../../lib/errorReportStore";
import { resolveModalOpen } from "./appSessionSelectors";
import { useAppSessionBridgeActions } from "./useAppSessionBridgeActions";
import {
  useAppSessionCoreState,
  type AppSessionCoreState,
} from "./useAppSessionCoreState";
import { useAppSessionDerivedState } from "./useAppSessionDerivedState";
import { useAppSessionLifecycleEffects } from "./useAppSessionLifecycleEffects";
import { useAppSessionUiState } from "./useAppSessionUiState";
import { useModalController } from "./useModalController";

export function useChapterSessionController() {
  const core = useAppSessionCoreState();
  const statusLog = useStatusLog();
  const uiState = useAppSessionUiState();
  const errorReportIncident = useErrorReportIncident();
  usePruneRemovedPageMasks(core.currentChapter, uiState);
  const modalController = useModalController({
    pushStatus: statusLog.pushStatus,
    uiState,
  });
  const derivedState = useAppSessionDerivedState({
    currentChapter: core.currentChapter,
    imageRef: core.imageRef,
    inpaintingTool: uiState.inpaintingTool,
    jobState: core.jobState,
    patternMaskStrokesByPage: uiState.patternMaskStrokesByPage,
    peekOriginal: uiState.peekOriginal,
    regionSelection: core.regionSelection,
    selectedBlockId: core.selectedBlockId,
    selectedBlockIds: core.selectedBlockIds,
    selectedPageId: core.selectedPageId,
  });
  const runtime = useChapterRuntimeController({
    core,
    derivedState,
    modalController,
    errorReportIncident,
    statusLog,
    uiState,
  });

  return {
    ...modalController,
    ...runtime,
    core,
    derivedState,
    statusLog,
    uiState,
  };
}

function usePruneRemovedPageMasks(
  currentChapter: AppSessionCoreState["currentChapter"],
  uiState: ReturnType<typeof useAppSessionUiState>,
): void {
  const { setPatternMaskStrokesByPage } = uiState;
  const chapterId = currentChapter?.id ?? null;
  const pageIdsKey =
    currentChapter?.pages.map((page) => page.id).join("\u0000") ?? "";
  useEffect(() => {
    if (!chapterId) return;
    const pageIds = new Set(pageIdsKey ? pageIdsKey.split("\u0000") : []);
    setPatternMaskStrokesByPage((current) => {
      const validEntries = Object.entries(current).filter(([pageId]) =>
        pageIds.has(pageId),
      );
      return validEntries.length === Object.keys(current).length
        ? current
        : Object.fromEntries(validEntries);
    });
  }, [chapterId, pageIdsKey, setPatternMaskStrokesByPage]);
}

export type ChapterSessionController = ReturnType<
  typeof useChapterSessionController
>;

type ChapterRuntimeArgs = Pick<
  ChapterSessionController,
  "derivedState" | "statusLog" | "uiState"
> & {
  core: AppSessionCoreState;
  errorReportIncident: ReturnType<typeof useErrorReportIncident>;
  modalController: Pick<
    ChapterSessionController,
    "confirmController" | "importShareModal" | "settingsDialog"
  >;
};

function useChapterRuntimeController({
  core,
  derivedState,
  errorReportIncident,
  modalController,
  statusLog,
  uiState,
}: ChapterRuntimeArgs) {
  const { t } = useTranslation("renderer");
  const { patternMaskStrokesByPage, setPatternMaskStrokesByPage } = uiState;
  const hasPendingInpaintingMask = useMemo(
    () => hasPendingMasks(patternMaskStrokesByPage),
    [patternMaskStrokesByPage],
  );
  const clearPendingInpaintingMasks = useCallback(
    () => setPatternMaskStrokesByPage({}),
    [setPatternMaskStrokesByPage],
  );
  const persistence = useNotifyingChapterPersistence(core, statusLog, t);
  const bridgeActions = useAppSessionBridgeActions(statusLog.pushStatus);
  const libraryActions = useLibraryActions({
    askConfirm: modalController.confirmController.askConfirm,
    clearDirtyTracking: persistence.clearDirtyTracking,
    currentChapter: core.currentChapter,
    currentChapterRef: core.currentChapterRef,
    dirty: persistence.dirty,
    hasPendingInpaintingMask,
    library: core.library,
    pushStatus: statusLog.pushStatus,
    clearPendingInpaintingMasks,
    onChapterOpened: uiState.resetChapterScopedUi,
    resetSaveBaseline: persistence.resetSaveBaseline,
    saveNow: persistence.saveNow,
    setCurrentChapter: core.setCurrentChapter,
    setLibrary: core.setLibrary,
    setSelectedBlockId: core.setSelectedBlockId,
    setSelectedPageId: core.setSelectedPageId,
  });
  const overlayModalsOpen = resolveOverlayModalsOpen({
    errorReportIncident,
    libraryActions,
    modalController,
    uiState,
  });
  const modalOpen = resolveModalOpen(
    [overlayModalsOpen],
    uiState.commandPaletteOpen,
    uiState.shortcutHelpOpen,
  );
  const mergeLiveChapter = useLiveChapterSync({
    currentChapter: core.currentChapter,
    currentChapterRef: core.currentChapterRef,
    dirtyPageIdsRef: persistence.dirtyPageIdsRef,
    replaceDirtyPageIds: persistence.replaceDirtyPageIds,
    selectedBlockId: core.selectedBlockId,
    selectedBlockIdRef: core.selectedBlockIdRef,
    selectedPageId: core.selectedPageId,
    selectedPageIdRef: core.selectedPageIdRef,
    setCurrentChapter: core.setCurrentChapter,
    setSelectedBlockId: core.setSelectedBlockId,
    setSelectedPageId: core.setSelectedPageId,
  });
  useChapterRuntimeEffects({
    core,
    derivedState,
    libraryActions,
    mergeLiveChapter,
    statusLog,
    uiState,
  });

  return {
    bridgeActions,
    libraryActions,
    mergeLiveChapter,
    modalOpen,
    overlayModalsOpen,
    persistence,
  };
}

function useNotifyingChapterPersistence(
  core: AppSessionCoreState,
  statusLog: ChapterRuntimeArgs["statusLog"],
  t: TFunction<"renderer">,
): ReturnType<typeof useChapterPersistence> {
  return useChapterPersistence({
    currentChapter: core.currentChapter,
    currentChapterRef: core.currentChapterRef,
    onSaveError: (message) => {
      const localized = t("chapter.saveFailed", { message });
      statusLog.pushStatus(localized);
      toast.error(localized);
    },
    setCurrentChapter: core.setCurrentChapter,
  });
}

function hasPendingMasks(
  masks: ReturnType<typeof useAppSessionUiState>["patternMaskStrokesByPage"],
): boolean {
  return Object.values(masks).some((strokes) => strokes.length > 0);
}

function resolveOverlayModalsOpen({
  errorReportIncident,
  libraryActions,
  modalController,
  uiState,
}: Pick<ChapterSessionController, "libraryActions" | "uiState"> & {
  errorReportIncident: ReturnType<typeof useErrorReportIncident>;
  modalController: Pick<
    ChapterSessionController,
    "confirmController" | "importShareModal" | "settingsDialog"
  >;
}): boolean {
  return resolveModalOpen(
    [
      modalController.importShareModal.translationSourceOpen,
      modalController.importShareModal.importPreview,
      modalController.importShareModal.shareExportOpen,
      modalController.importShareModal.shareImportPreview,
      libraryActions.renameTarget,
      modalController.settingsDialog.settingsOpen,
      modalController.confirmController.confirmDialog,
      uiState.inpaintingGuideOpen,
      uiState.autoInpaintingOptionsOpen,
      uiState.exportOptionsOpen,
      uiState.textViewOpen,
      uiState.styleGuideOpen,
      uiState.translateOptionsOpen,
      uiState.retranslatePageId,
      errorReportIncident,
    ],
    false,
    false,
  );
}

function useChapterRuntimeEffects({
  core,
  derivedState,
  libraryActions,
  mergeLiveChapter,
  statusLog,
  uiState,
}: Pick<
  ChapterSessionController,
  | "core"
  | "derivedState"
  | "libraryActions"
  | "mergeLiveChapter"
  | "statusLog"
  | "uiState"
>): void {
  const { selectWorkspaceTool, setPeekOriginal } = uiState;
  const handleJobStart = useCallback(
    () => selectWorkspaceTool("select"),
    [selectWorkspaceTool],
  );
  const handlePageChange = useCallback(() => {
    setPeekOriginal(false);
  }, [setPeekOriginal]);
  useAppSessionLifecycleEffects({
    currentChapter: core.currentChapter,
    jobState: core.jobState,
    onJobStart: handleJobStart,
    onPageChange: handlePageChange,
    openErrorReport,
    refreshLibrary: libraryActions.refreshLibrary,
    resetChapterScopedUi: uiState.resetChapterScopedUi,
    selectedPageId: derivedState.selectedPage?.id ?? null,
    setRegionSelection: core.setRegionSelection,
    translationFlowActive: uiState.translationFlowActive,
  });

  useJobEvents({
    appendStatusLine: statusLog.appendStatusLine,
    currentChapterRef: core.currentChapterRef,
    mergeLiveChapter,
    setJobState: core.setJobState,
  });
}
