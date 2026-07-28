import {
  useShortcutDispatcher,
  type ShortcutHandlers,
} from "../../hooks/useShortcutDispatcher";
import type { ShortcutContext } from "../../lib/shortcuts/shortcutActions";
import type { ChapterSessionController } from "./useChapterSessionController";
import type { InpaintingController } from "./useInpaintingController";
import type { TranslationController } from "./useTranslationController";
import { useSelectedBlockKeyboardNudge } from "../../hooks/useSelectedBlockKeyboardNudge";
import { isBlockEditingTool } from "../../lib/stageTool";

type AppSessionShortcutsArgs = {
  chapter: ChapterSessionController;
  translation: TranslationController;
  inpainting: InpaintingController;
};

/**
 * Mounts the global customizable-shortcut dispatcher, mapping every registered
 * action to the relevant controller handler and exposing the runtime context
 * used to guard them.
 */
export function useAppSessionShortcuts({
  chapter,
  translation,
  inpainting,
}: AppSessionShortcutsArgs): void {
  const { core, derivedState, uiState } = chapter;
  const { blockEditingActions, translationActions, workspaceHistory } =
    translation;
  const selectStageTool = (tool: "select" | "block" | "hand"): void => {
    core.setRegionSelection(null);
    uiState.selectWorkspaceTool(tool);
  };
  const jobActive =
    inpainting.inpaintingBridge.contextValue.jobActive ||
    uiState.translationFlowActive ||
    workspaceHistory.busy;

  const context: ShortcutContext = {
    blockingModalOpen: chapter.overlayModalsOpen,
    paletteOpen: uiState.commandPaletteOpen,
    helpOpen: uiState.shortcutHelpOpen,
    chapterOpen: Boolean(core.currentChapter),
    jobActive,
    retouchToolActive: derivedState.inpaintingToolActive,
    blockSelected: Boolean(derivedState.selectedBlock),
  };

  useSelectedBlockKeyboardNudge({
    blocked: chapter.modalOpen,
    enabled:
      Boolean(derivedState.selectedBlock) &&
      !derivedState.selectedPageEditLocked &&
      !derivedState.showingOriginalPeek &&
      !jobActive &&
      uiState.showTextBlocks &&
      isBlockEditingTool(uiState.stageTool),
    onNudge: blockEditingActions.nudgeSelectedBlocks,
    workspacePanelRef: core.workspacePanelRef,
  });

  const handlers: ShortcutHandlers = {
    "toggle-block-chrome": () => uiState.setShowBlockChrome((value) => !value),
    "toggle-text-blocks": () => uiState.setShowTextBlocks((value) => !value),
    "toggle-peek-original": () => uiState.setPeekOriginal((value) => !value),
    "zoom-in": () => uiState.zoomInWorkspace(),
    "zoom-out": () => uiState.zoomOutWorkspace(),
    "zoom-reset": () => uiState.resetWorkspaceZoom(),
    "stage-tool-select": () => selectStageTool("select"),
    "stage-tool-block": () => selectStageTool("block"),
    "stage-tool-hand": () => selectStageTool("hand"),
    "toggle-stage-toolbar": () =>
      uiState.setStageToolbarHidden((hidden) => !hidden),
    "open-translate-options": () => uiState.setTranslateOptionsOpen(true),
    "translate-pending": () => void translationActions.runAnalysis("pending"),
    "translate-all": () => void translationActions.runAnalysis("all"),
    "gather-text": () => uiState.setTextViewOpen(true),
    "cancel-job": () => chapter.bridgeActions.cancelJob(),
    "toggle-inpainting": () => openCurrentPageEraseOptions(chapter),
    "history-undo": () => void workspaceHistory.undo(),
    "history-redo": () => void workspaceHistory.redo(),
    "delete-block": () => blockEditingActions.deleteSelectedBlock(),
    "duplicate-block": () => blockEditingActions.duplicateSelectedBlock(),
    "toggle-block-excluded": () => {
      const blockId = core.selectedBlockId;
      if (blockId) {
        blockEditingActions.toggleBlockInpaintExcluded(blockId);
      }
    },
    "toggle-command-palette": () =>
      uiState.setCommandPaletteOpen((open) => !open),
    "toggle-shortcut-help": () => uiState.setShortcutHelpOpen((open) => !open),
    "open-settings": () => void chapter.settingsDialog.openSettings(),
  };

  useShortcutDispatcher({
    context,
    handlers,
    overrides: chapter.settingsDialog.settings?.keybindings ?? {},
  });
}

function openCurrentPageEraseOptions(chapter: ChapterSessionController): void {
  chapter.core.setRegionSelection(null);
  chapter.uiState.selectWorkspaceTool("select");
  chapter.uiState.setPeekOriginal(false);
  chapter.uiState.setAutoInpaintingEntryScope("current");
  chapter.uiState.setAutoInpaintingOptionsOpen(true);
}
