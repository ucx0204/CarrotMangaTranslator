import { useChapterPersistence } from "../../hooks/useChapterPersistence";
import { useTranslation } from "react-i18next";
import { useJobEvents } from "../../hooks/useJobEvents";
import { useLibraryActions } from "../../hooks/useLibraryActions";
import { useLiveChapterSync } from "../../hooks/useLiveChapterSync";
import { useStatusLog } from "../../hooks/useStatusLog";
import { toast } from "../../lib/toastStore";
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
  const modalController = useModalController({
    pushStatus: statusLog.pushStatus,
    uiState,
  });
  const derivedState = useAppSessionDerivedState({
    currentChapter: core.currentChapter,
    imageRef: core.imageRef,
    inpaintingMode: uiState.inpaintingMode,
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

export type ChapterSessionController = ReturnType<
  typeof useChapterSessionController
>;

type ChapterRuntimeArgs = Pick<
  ChapterSessionController,
  "derivedState" | "statusLog" | "uiState"
> & {
  core: AppSessionCoreState;
  modalController: Pick<
    ChapterSessionController,
    "confirmController" | "importShareModal" | "settingsDialog"
  >;
};

function useChapterRuntimeController({
  core,
  derivedState,
  modalController,
  statusLog,
  uiState,
}: ChapterRuntimeArgs) {
  const { t } = useTranslation("renderer");
  const persistence = useChapterPersistence({
    currentChapter: core.currentChapter,
    currentChapterRef: core.currentChapterRef,
    onSaveError: (message) => {
      const localized = t("chapter.saveFailed", { message });
      statusLog.pushStatus(localized);
      toast.error(localized);
    },
    setCurrentChapter: core.setCurrentChapter,
  });
  const bridgeActions = useAppSessionBridgeActions(statusLog.pushStatus);
  const libraryActions = useLibraryActions({
    askConfirm: modalController.confirmController.askConfirm,
    clearDirtyTracking: persistence.clearDirtyTracking,
    currentChapter: core.currentChapter,
    currentChapterRef: core.currentChapterRef,
    dirty: persistence.dirty,
    library: core.library,
    pushStatus: statusLog.pushStatus,
    resetSaveBaseline: persistence.resetSaveBaseline,
    saveNow: persistence.saveNow,
    setCurrentChapter: core.setCurrentChapter,
    setLibrary: core.setLibrary,
    setSelectedBlockId: core.setSelectedBlockId,
    setSelectedPageId: core.setSelectedPageId,
  });
  const overlayModalsOpen = resolveOverlayModalsOpen({
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
    bridgeActions,
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

function resolveOverlayModalsOpen({
  libraryActions,
  modalController,
  uiState,
}: Pick<ChapterSessionController, "libraryActions" | "uiState"> & {
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
      uiState.textViewOpen,
      uiState.styleGuideOpen,
      uiState.translateOptionsOpen,
      uiState.retranslatePageId,
    ],
    false,
    false,
  );
}

function useChapterRuntimeEffects({
  bridgeActions,
  core,
  derivedState,
  libraryActions,
  mergeLiveChapter,
  statusLog,
  uiState,
}: Pick<
  ChapterSessionController,
  | "bridgeActions"
  | "core"
  | "derivedState"
  | "libraryActions"
  | "mergeLiveChapter"
  | "statusLog"
  | "uiState"
>): void {
  useAppSessionLifecycleEffects({
    currentChapter: core.currentChapter,
    jobState: core.jobState,
    openLogFolder: bridgeActions.openLogFolder,
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
    refreshLibrary: libraryActions.refreshLibrary,
    setJobState: core.setJobState,
  });
}
