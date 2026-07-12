import { useCallback } from "react";
import type { PanelCommand } from "../../../shared/panelBridgeTypes";
import { useWorkspaceWheelZoom } from "../hooks/useWorkspaceWheelZoom";
import { usePanelBridgeHost } from "../panels/usePanelBridgeHost";
import {
  buildPanelSyncState,
  createAppSessionViewProps,
} from "./session/createAppSessionViewProps";
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
      const actions = translation.blockEditingActions;
      if (command.type === "updateBlock") {
        actions.updateSelectedBlock(command.patch);
      } else if (command.type === "deleteBlock") {
        actions.deleteSelectedBlock();
      } else if (command.type === "duplicateBlock") {
        actions.duplicateSelectedBlock();
      } else if (command.type === "applyFormat") {
        actions.applyFormatToScope(command.scope, command.groupIds);
      } else {
        inpainting.pointerHandlers.startRegionTranslationSelection();
      }
    },
    [translation.blockEditingActions, inpainting.pointerHandlers],
  );

  const panelBridge = usePanelBridgeHost({
    syncState: buildPanelSyncState({
      core: chapter.core,
      derivedState: chapter.derivedState,
      uiState: chapter.uiState,
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
  });
}
