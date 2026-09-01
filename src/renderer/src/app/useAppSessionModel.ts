import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  createPanelSelectionKey,
  type PanelCommand,
} from "../../../shared/panelBridgeTypes";
import { useWorkspaceWheelZoom } from "../hooks/useWorkspaceWheelZoom";
import { useLibraryDropImport } from "../hooks/useLibraryDropImport";
import { usePanelBridgeHost } from "../panels/usePanelBridgeHost";
import { createAppSessionViewProps } from "./session/createAppSessionViewProps";
import { buildPanelSyncState } from "./session/buildPanelSyncState";
import type { AppSessionViewProps } from "./session/AppSessionView";
import { useAppSessionShortcuts } from "./session/useAppSessionShortcuts";
import {
  useChapterSessionController,
  type ChapterSessionController,
} from "./session/useChapterSessionController";
import {
  useInpaintingController,
  type InpaintingController,
} from "./session/useInpaintingController";
import {
  useTranslationController,
  type TranslationController,
} from "./session/useTranslationController";
import { dispatchPanelCommand } from "./session/panelCommandDispatcher";
import { createStylePresetDeleteAction } from "./session/createStylePresetDeleteAction";
import {
  createStylePresetRenameAction,
  createStylePresetOverwriteAction,
  createStylePresetSaveAction,
} from "./session/createStylePresetSaveAction";
import type { WorkspaceWheelZoomGesture } from "../lib/workspaceZoom";
import { useLinkedWorkspaceActivityReporter } from "../hooks/useLinkedWorkspaceActivityReporter";

export function useAppSessionModel(): AppSessionViewProps {
  const chapter = useChapterSessionController();
  const linkedWorkspaceChapterIds = useMemo(
    () => chapter.core.library.works.flatMap((work) => work.chapterOrder),
    [chapter.core.library.works],
  );
  useLinkedWorkspaceActivityReporter(linkedWorkspaceChapterIds);
  const clearRetouchHistoryRef = useRef<() => void>(() => undefined);
  const clearRetouchHistory = useCallback(
    () => clearRetouchHistoryRef.current(),
    [],
  );
  const translation = useTranslationController(chapter, clearRetouchHistory);
  const inpainting = useInpaintingController(chapter, translation);
  const libraryDrop = useSessionLibraryDrop(chapter, translation);
  useEffect(() => {
    clearRetouchHistoryRef.current = inpainting.clearRetouchHistory;
  }, [inpainting.clearRetouchHistory]);

  useAppSessionShortcuts({ chapter, inpainting, translation });
  useWorkspaceWheelZoom({
    workspacePanelRef: chapter.core.workspacePanelRef,
    zoom: (gesture) => dispatchWorkspaceWheelZoom(chapter, gesture),
    fitHeight: () => chapter.uiState.setWorkspaceFitMode("height"),
    overrides: chapter.settingsDialog.settings?.keybindings,
  });
  const applyPanelCommand = usePanelCommandHandler(
    chapter,
    translation,
    inpainting,
  );

  const panelBridge = usePanelBridgeHost({
    syncState: buildPanelSyncState({
      blockEditingActions: translation.blockEditingActions,
      core: chapter.core,
      derivedState: chapter.derivedState,
      inpaintingBridge: inpainting.inpaintingBridge,
      uiState: chapter.uiState,
      workspaceHistory: translation.workspaceHistory,
    }),
    onCommand: applyPanelCommand,
  });

  return createAppSessionViewProps({
    blockEditingActions: translation.blockEditingActions,
    bridgeActions: chapter.bridgeActions,
    completionSound: chapter.completionSound,
    commands: inpainting.commands,
    confirmController: chapter.confirmController,
    core: chapter.core,
    derivedState: chapter.derivedState,
    guidePreference: chapter.guidePreference,
    importShareActions: translation.importShareActions,
    importShareModal: chapter.importShareModal,
    inpaintingActions: inpainting.inpaintingActions,
    inpaintingBridge: inpainting.inpaintingBridge,
    libraryActions: chapter.libraryActions,
    linkedWorkspace: chapter.linkedWorkspace,
    operationActivity: chapter.operationActivity,
    libraryDrop,
    panelBridge,
    persistence: chapter.persistence,
    pageNavigationHandlers: inpainting.pageNavigationHandlers,
    pointerHandlers: inpainting.pointerHandlers,
    retranslatePage: translation.retranslatePage,
    settingsDialog: chapter.settingsDialog,
    statusLog: chapter.statusLog,
    translationActions: translation.translationActions,
    uiState: chapter.uiState,
    updateCurrentChapter: translation.updateCurrentChapter,
    workspaceHistory: translation.workspaceHistory,
  });
}

function useSessionLibraryDrop(
  chapter: ChapterSessionController,
  translation: TranslationController,
) {
  return useLibraryDropImport({
    blocked:
      chapter.dropImportModalBlocked ||
      chapter.derivedState.jobActive ||
      chapter.uiState.translationFlowActive ||
      translation.workspaceHistory.busy ||
      chapter.operationActivity.active ||
      chapter.importShareModal.importBusy,
    pushStatus: chapter.statusLog.pushStatus,
    setImportPreview: chapter.importShareModal.setImportPreview,
    setTranslationSourceOpen: chapter.importShareModal.setTranslationSourceOpen,
  });
}

function dispatchWorkspaceWheelZoom(
  chapter: ChapterSessionController,
  gesture: WorkspaceWheelZoomGesture,
): void {
  const controller = chapter.core.workspaceZoomControllerRef.current;
  if (controller) controller.zoomAtPointer(gesture);
  else if (gesture.direction === "in") chapter.uiState.zoomInWorkspace();
  else chapter.uiState.zoomOutWorkspace();
}

function createPanelStylePresetActions(chapter: ChapterSessionController) {
  const model = {
    derivedState: chapter.derivedState,
    settingsDialog: chapter.settingsDialog,
    statusLog: chapter.statusLog,
  };
  return {
    createStylePreset: createStylePresetSaveAction(model),
    deleteStylePreset: createStylePresetDeleteAction(model),
    overwriteStylePreset: createStylePresetOverwriteAction(model),
    renameStylePreset: createStylePresetRenameAction(model),
  };
}

function usePanelCommandHandler(
  chapter: ChapterSessionController,
  translation: TranslationController,
  inpainting: InpaintingController,
): (command: PanelCommand) => void {
  const actions = translation.blockEditingActions;
  const busy =
    chapter.derivedState.selectedPageEditLocked ||
    translation.workspaceHistory.busy;
  const selectedBlockId = chapter.derivedState.selectedBlock?.id ?? null;
  const selectionKey = createPanelSelectionKey(
    chapter.derivedState.selectedBlockIds.length > 0
      ? chapter.derivedState.selectedBlockIds
      : selectedBlockId
        ? [selectedBlockId]
        : [],
  );
  const selectWorkspaceTool = chapter.uiState.selectWorkspaceTool;
  const setBlockLibraryOpen = chapter.uiState.setBlockLibraryOpen;
  const setFontManagerOpen = chapter.uiState.setFontManagerOpen;
  const openSettings = chapter.settingsDialog.openSettings;
  const setConditionalBatchOpen = chapter.uiState.setConditionalBatchOpen;
  const setConditionalBatchInitialFind =
    chapter.uiState.setConditionalBatchInitialFind;
  const setConditionalBatchInitialReplace =
    chapter.uiState.setConditionalBatchInitialReplace;
  const startAreaTranslate =
    inpainting.pointerHandlers.startRegionTranslationSelection;
  const runInpainting = inpainting.inpaintingActions.runInpainting;
  const runBubbleLayout = inpainting.inpaintingActions.runBubbleLayout;
  const presetActions = createPanelStylePresetActions(chapter);
  return useCallback(
    (command: PanelCommand) => {
      dispatchPanelCommand({
        actions: {
          ...actions,
          eraseBlockOriginal: (blockId) => void runInpainting("page", blockId),
          fitBlockBubble: (blockId) => void runBubbleLayout(blockId),
          deleteStylePreset: (presetId) =>
            void presetActions.deleteStylePreset(presetId),
          createStylePreset: (input) =>
            void presetActions.createStylePreset(input),
          openStylePresetManager: () => void openSettings("style-presets"),
          openFontManager: () => setFontManagerOpen(true),
          overwriteStylePreset: (presetId) =>
            void presetActions.overwriteStylePreset(presetId),
          renameStylePreset: (presetId, name) =>
            void presetActions.renameStylePreset(presetId, name),
          openBlockLibrary: () => setBlockLibraryOpen(true),
          suggestConsistentEdit: (find, replace) => {
            setConditionalBatchInitialFind(find);
            setConditionalBatchInitialReplace(replace);
            setConditionalBatchOpen(true);
          },
          selectWorkspaceTool,
          startAreaTranslate,
        },
        busy,
        command,
        selectedBlockId,
        selectionKey,
      });
    },
    [
      actions,
      busy,
      presetActions,
      openSettings,
      runBubbleLayout,
      runInpainting,
      selectedBlockId,
      selectionKey,
      selectWorkspaceTool,
      setBlockLibraryOpen,
      setFontManagerOpen,
      setConditionalBatchInitialFind,
      setConditionalBatchInitialReplace,
      setConditionalBatchOpen,
      startAreaTranslate,
    ],
  );
}
