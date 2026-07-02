import {
  useShortcutDispatcher,
  type ShortcutHandlers,
} from "../../hooks/useShortcutDispatcher";
import type { ShortcutContext } from "../../lib/shortcuts/shortcutActions";
import type { ChapterSessionController } from "./useChapterSessionController";
import type { InpaintingController } from "./useInpaintingController";
import type { TranslationController } from "./useTranslationController";

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
  const { blockEditingActions, chapterHistory, translationActions } =
    translation;
  const { inpaintingActions, inpaintingBridge } = inpainting;

  const context: ShortcutContext = {
    blockingModalOpen: chapter.overlayModalsOpen,
    paletteOpen: uiState.commandPaletteOpen,
    helpOpen: uiState.shortcutHelpOpen,
    chapterOpen: Boolean(core.currentChapter),
    jobActive: derivedState.jobActive,
    inpaintingMode: uiState.inpaintingMode,
    blockSelected: Boolean(derivedState.selectedBlock),
  };

  const handlers: ShortcutHandlers = {
    "toggle-block-chrome": () => uiState.setShowBlockChrome((value) => !value),
    "toggle-text-blocks": () => uiState.setShowTextBlocks((value) => !value),
    "toggle-peek-original": () => uiState.setPeekOriginal((value) => !value),
    "zoom-in": () => uiState.zoomInWorkspace(),
    "zoom-out": () => uiState.zoomOutWorkspace(),
    "zoom-reset": () => uiState.resetWorkspaceZoom(),
    "stage-tool-select": () => uiState.setStageTool("select"),
    "stage-tool-block": () => uiState.setStageTool("block"),
    "stage-tool-hand": () => uiState.setStageTool("hand"),
    "toggle-stage-toolbar": () =>
      uiState.setStageToolbarHidden((hidden) => !hidden),
    "open-translate-options": () => uiState.setTranslateOptionsOpen(true),
    "translate-pending": () => void translationActions.runAnalysis("pending"),
    "translate-all": () => void translationActions.runAnalysis("all"),
    "gather-text": () => uiState.setTextViewOpen(true),
    "cancel-job": () => chapter.bridgeActions.cancelJob(),
    "toggle-inpainting": () => {
      if (uiState.inpaintingMode) {
        inpaintingActions.exitInpaintingMode();
      } else {
        void inpaintingActions.enterInpaintingMode();
      }
    },
    // Ctrl+Z / Ctrl+Shift+Z: inpainting retouch owns them while in inpainting
    // mode, otherwise they drive the chapter edit history.
    "history-undo": () => {
      if (uiState.inpaintingMode) {
        inpaintingBridge.contextValue.onUndoRetouch();
      } else {
        chapterHistory.undo();
      }
    },
    "history-redo": () => {
      if (uiState.inpaintingMode) {
        inpaintingBridge.contextValue.onRedoRetouch();
      } else {
        chapterHistory.redo();
      }
    },
    "retouch-redo": () => inpaintingBridge.contextValue.onRedoRetouch(),
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
