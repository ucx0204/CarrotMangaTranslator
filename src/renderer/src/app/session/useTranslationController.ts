import { useBlockEditingActions } from "../../hooks/useBlockEditingActions";
import { useCurrentChapterUpdater } from "../../hooks/useCurrentChapterUpdater";
import { useImportShareActions } from "../../hooks/useImportShareActions";
import { usePageRetranslationAction } from "../../hooks/usePageRetranslationAction";
import { useRegionTranslationPreparation } from "../../hooks/useRegionTranslationPreparation";
import {
  useTranslationActions,
  type UseTranslationActionsOptions,
} from "../../hooks/useTranslationActions";
import type { ChapterSessionController } from "./useChapterSessionController";
import { useAppSessionWorkspaceHistory } from "./useAppSessionWorkspaceHistory";
import { useFonts } from "../../fonts/useFonts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { captureWorkspaceChapterEditSnapshot } from "../../lib/workspaceHistory";
import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";
import { resolveReadingDirection } from "../../../../shared/blockReadingOrder";

export function useTranslationController(
  chapter: ChapterSessionController,
  clearRetouchHistory: () => void,
) {
  const { options: fontOptions } = useFonts();
  const availableFontIds = useMemo(
    () => new Set(fontOptions.map((font) => font.id)),
    [fontOptions],
  );
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
    availableFontIds,
    blockStylePresets: chapter.settingsDialog.settings?.blockStylePresets,
    currentChapter: chapter.core.currentChapter,
    jobActive:
      chapter.derivedState.jobActive ||
      chapter.uiState.translationFlowActive ||
      workspaceHistory.busy,
    pushStatus: chapter.statusLog.pushStatus,
    readingDirection: resolveReadingDirection(
      chapter.core.library.works.find(
        (work) => work.id === chapter.core.currentChapter?.workId,
      )?.readingDirection,
      resolveSourceReadingDirection(
        chapter.settingsDialog.settings?.translation?.sourceLanguage,
      ),
    ),
    selectedBlock: chapter.derivedState.selectedBlock,
    selectedBlockIds: chapter.derivedState.selectedBlockIds,
    selectedPage: chapter.derivedState.selectedPage,
    selectedPageEditLocked:
      chapter.derivedState.selectedPageEditLocked || workspaceHistory.busy,
    stageRef: chapter.core.stageRef,
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
  const getNavigationKey = useNavigationIdentity(
    chapter.core.currentChapter?.id,
    chapter.core.selectedPageId,
  );
  return useImportShareActions({
    applyChapter: chapter.libraryActions.applyChapter,
    askConfirm: chapter.confirmController.askConfirm,
    dirty: chapter.persistence.dirty,
    getNavigationKey,
    importPreview: chapter.importShareModal.importPreview,
    setImportModalOpen: chapter.importShareModal.setImportModalOpen,
    setImportDraft: chapter.importShareModal.setImportDraft,
    setImportFeedback: chapter.importShareModal.setImportFeedback,
    openTranslateOptions: chapter.uiState.openTranslateOptions,
    pushStatus: chapter.statusLog.pushStatus,
    refreshLibrary: chapter.libraryActions.refreshLibrary,
    saveNow: chapter.persistence.saveNow,
    setImportBusy: chapter.importShareModal.setImportBusy,
    setImportPreview: chapter.importShareModal.setImportPreview,
    setShareExportBusy: chapter.importShareModal.setShareExportBusy,
    setShareExportDraft: chapter.importShareModal.setShareExportDraft,
    setShareExportOpen: chapter.importShareModal.setShareExportOpen,
    setShareImportBusy: chapter.importShareModal.setShareImportBusy,
    setShareImportDraft: chapter.importShareModal.setShareImportDraft,
    setShareImportPreview: chapter.importShareModal.setShareImportPreview,
    setTranslationSourceOpen: chapter.importShareModal.setTranslationSourceOpen,
    setWebImportOpen: chapter.importShareModal.setWebImportOpen,
    shareImportPreview: chapter.importShareModal.shareImportPreview,
    resetWorkspaceHistory,
  });
}

function useNavigationIdentity(
  currentChapterId: string | undefined,
  selectedPageId: string | null,
): () => string {
  const revisionRef = useRef(0);
  const currentIdentity = [currentChapterId ?? "", selectedPageId ?? ""].join(
    ":",
  );
  const previousIdentityRef = useRef(currentIdentity);
  const navigationIdentityRef = useRef(`0:${currentIdentity}`);
  useEffect(() => {
    if (previousIdentityRef.current === currentIdentity) {
      return;
    }
    previousIdentityRef.current = currentIdentity;
    revisionRef.current += 1;
    navigationIdentityRef.current = `${revisionRef.current}:${currentIdentity}`;
  }, [currentIdentity]);
  return () => navigationIdentityRef.current;
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
  const recordTranslationCheckpoint = useCallback<
    NonNullable<UseTranslationActionsOptions["recordTranslationCheckpoint"]>
  >(
    ({ before, after, pageIds, label }) => {
      const selection = {
        selectedPageId: chapter.core.selectedPageId,
        selectedBlockId: chapter.core.selectedBlockId,
        selectedBlockIds: chapter.core.selectedBlockIds,
      };
      workspaceHistory.recordChapterEdit({
        label,
        before: captureWorkspaceChapterEditSnapshot(before, selection, pageIds),
        after: captureWorkspaceChapterEditSnapshot(after, selection, pageIds),
      });
    },
    [
      chapter.core.selectedBlockId,
      chapter.core.selectedBlockIds,
      chapter.core.selectedPageId,
      workspaceHistory,
    ],
  );

  return useTranslationActions({
    beforeTranslate: async () => {
      await prepareRegionTranslation();
    },
    clearPageImageCache: chapter.derivedState.clearPageImageCache,
    clearRetouchHistory,
    currentChapter: chapter.core.currentChapter,
    currentChapterRef: chapter.core.currentChapterRef,
    flowCancellationRef: chapter.uiState.jobFlowCancellationRef,
    jobActive:
      chapter.derivedState.jobActive ||
      chapter.operationActivity.active ||
      chapter.importShareModal.importBusy,
    library: chapter.core.library,
    mergeLiveChapter: chapter.mergeLiveChapter,
    pushStatus: chapter.statusLog.pushStatus,
    refreshLibrary: chapter.libraryActions.refreshLibrary,
    saveNow: chapter.persistence.saveNow,
    selectedPage: chapter.derivedState.selectedPage,
    translationWorkflowDefault:
      uiDefaults.translationWorkflowDefault ?? "cumulative",
    cumulativeContextDetailDefault:
      uiDefaults.cumulativeContextDetailDefault ?? "detailed",
    autoFontMatchingDefault: uiDefaults.autoFontMatchingDefault ?? false,
    naturalTextLayoutDefault: uiDefaults.naturalTextLayoutDefault ?? true,
    fontSizeAutoFitDefault: uiDefaults.fontSizeAutoFitDefault ?? true,
    recordImageEdit: workspaceHistory.recordImageEdit,
    recordTranslationCheckpoint,
    setCurrentChapter: chapter.core.setCurrentChapter,
    setFlowActive: chapter.uiState.setTranslationFlowActive,
    setShowBlockChrome: chapter.uiState.setShowBlockChrome,
    setJobState: chapter.core.setJobState,
    setSelectedBlockId: chapter.core.setSelectedBlockId,
    syncSavedPageVersion: chapter.persistence.syncSavedPageVersion,
  });
}
