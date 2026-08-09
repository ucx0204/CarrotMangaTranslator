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
import {
  resolveAdjacentBlockId,
  type BlockNavigationDirection,
} from "../../lib/blockNavigation";
import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";

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
  const { context, jobActive } = resolveShortcutRuntime(
    chapter,
    translation,
    inpainting,
  );

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
    "page-previous": () =>
      inpainting.pageNavigationHandlers.selectAdjacentPageForReading(
        "previous",
      ),
    "page-next": () =>
      inpainting.pageNavigationHandlers.selectAdjacentPageForReading("next"),
    "stage-tool-select": () => selectStageTool("select"),
    "stage-tool-block": () => selectStageTool("block"),
    "stage-tool-hand": () => selectStageTool("hand"),
    "toggle-stage-toolbar": () =>
      uiState.setStageToolbarHidden((hidden) => !hidden),
    "open-translate-options": () => uiState.openTranslateOptions(),
    "translate-pending": () => void translationActions.runAnalysis("pending"),
    "translate-all": () => void translationActions.runAnalysis("all"),
    "gather-text": () => uiState.setTextViewOpen(true),
    "cancel-job": () => chapter.bridgeActions.cancelJob(),
    "toggle-inpainting": () => openCurrentPageEraseOptions(chapter),
    "block-previous": () => navigateBlock(chapter, "previous"),
    "block-next": () => navigateBlock(chapter, "next"),
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

function resolveShortcutRuntime(
  chapter: ChapterSessionController,
  translation: TranslationController,
  inpainting: InpaintingController,
): { context: ShortcutContext; jobActive: boolean } {
  const jobActive =
    inpainting.inpaintingBridge.contextValue.jobActive ||
    chapter.uiState.translationFlowActive ||
    translation.workspaceHistory.busy;
  return {
    jobActive,
    context: {
      blockingModalOpen: chapter.overlayModalsOpen,
      paletteOpen: chapter.uiState.commandPaletteOpen,
      helpOpen: chapter.uiState.shortcutHelpOpen,
      chapterOpen: Boolean(chapter.core.currentChapter),
      jobActive,
      retouchToolActive: chapter.derivedState.inpaintingToolActive,
      blockSelected: Boolean(chapter.derivedState.selectedBlock),
    },
  };
}

function navigateBlock(
  chapter: ChapterSessionController,
  direction: BlockNavigationDirection,
): void {
  const { core, derivedState, uiState } = chapter;
  const targetId = resolveAdjacentBlockId(
    derivedState.selectedPage?.blocks ?? [],
    core.selectedBlockId,
    direction,
    resolveSourceReadingDirection(
      chapter.settingsDialog.settings?.translation?.sourceLanguage,
    ),
  );
  if (!targetId) {
    return;
  }

  const moveTextareaFocus = isPageBlockTranslationTarget(
    typeof document === "undefined" ? null : document.activeElement,
  );
  core.selectedBlockIdRef.current = targetId;
  core.setSelectedBlockId(targetId);
  core.setSelectedBlockIds([targetId]);

  if (uiState.rightRailMode === "page-blocks") {
    revealPageBlockRow(targetId, moveTextareaFocus);
  }
}

function isPageBlockTranslationTarget(target: Element | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.dataset.pageBlockTranslation === "true"
  );
}

function revealPageBlockRow(blockId: string, focusTranslation: boolean): void {
  const reveal = (): void => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>("[data-page-block-id]"),
    ).find((node) => node.dataset.pageBlockId === blockId);
    row?.scrollIntoView({ block: "nearest" });
    if (focusTranslation) {
      row
        ?.querySelector<HTMLTextAreaElement>(
          'textarea[data-page-block-translation="true"]',
        )
        ?.focus();
    }
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(reveal);
  } else {
    window.setTimeout(reveal, 0);
  }
}

function openCurrentPageEraseOptions(chapter: ChapterSessionController): void {
  chapter.core.setRegionSelection(null);
  chapter.uiState.selectWorkspaceTool("select");
  chapter.uiState.setPeekOriginal(false);
  chapter.uiState.setAutoInpaintingEntryScope("current");
  chapter.uiState.setAutoInpaintingOptionsOpen(true);
}
