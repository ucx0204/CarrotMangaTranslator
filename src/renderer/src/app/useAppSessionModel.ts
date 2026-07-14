import { useCallback } from "react";
import type { PanelCommand } from "../../../shared/panelBridgeTypes";
import { useWorkspaceWheelZoom } from "../hooks/useWorkspaceWheelZoom";
import { usePanelBridgeHost } from "../panels/usePanelBridgeHost";
import { createAppSessionViewProps } from "./session/createAppSessionViewProps";
import { buildPanelSyncState } from "./session/buildPanelSyncState";
import type { AppSessionViewProps } from "./session/AppSessionView";
import { useAppSessionShortcuts } from "./session/useAppSessionShortcuts";
import { useChapterSessionController } from "./session/useChapterSessionController";
import { useInpaintingController } from "./session/useInpaintingController";
import { useTranslationController } from "./session/useTranslationController";

export function useAppSessionModel(): AppSessionViewProps {
  const chapter = useChapterSessionController();
  const translation = useTranslationController(chapter);
  const inpainting = useInpaintingController(chapter, translation);

  useAppSessionShortcuts({ chapter, inpainting, translation });
  useWorkspaceWheelZoom({
    workspacePanelRef: chapter.core.workspacePanelRef,
    zoomIn: chapter.uiState.zoomInWorkspace,
    zoomOut: chapter.uiState.zoomOutWorkspace,
  });

  const applyPanelCommand = useCallback(
    (command: PanelCommand) => {
      if (
        inpainting.inpaintingBridge.contextValue.jobActive ||
        chapter.uiState.translationFlowActive ||
        translation.workspaceHistory.busy
      ) {
        return;
      }
      const actions = translation.blockEditingActions;
      if (command.type === "updateBlock") {
        actions.updateSelectedBlock(command.patch);
      } else if (command.type === "adjustFontSize") {
        actions.adjustSelectedBlockFontSize(command.adjustment);
      } else if (command.type === "deleteBlock") {
        actions.deleteSelectedBlock();
      } else if (command.type === "duplicateBlock") {
        actions.duplicateSelectedBlock();
      } else if (command.type === "applyFormat") {
        actions.applyFormatToScope(command.scope, command.groupIds);
      } else if (command.type === "applyBlockBackgroundOpacity") {
        actions.applyBlockBackgroundOpacityToScope(command.scope);
      } else {
        inpainting.pointerHandlers.startRegionTranslationSelection();
      }
    },
    [
      chapter.uiState.translationFlowActive,
      inpainting.inpaintingBridge.contextValue.jobActive,
      inpainting.pointerHandlers,
      translation.blockEditingActions,
      translation.workspaceHistory.busy,
    ],
  );

  const panelBridge = usePanelBridgeHost({
    syncState: buildPanelSyncState({
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
    panelBridge,
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
