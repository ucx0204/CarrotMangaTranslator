import { useShortcutDispatcher } from "../../hooks/useShortcutDispatcher";
import type { ShortcutContext } from "../../lib/shortcuts/shortcutActionTypes";
import type { ChapterSessionController } from "./useChapterSessionController";
import type { InpaintingController } from "./useInpaintingController";
import type { TranslationController } from "./useTranslationController";
import { useSelectedBlockKeyboardNudge } from "../../hooks/useSelectedBlockKeyboardNudge";
import { isBlockEditingTool, type RetouchTool } from "../../lib/stageTool";
import {
  resolveAdjacentBlockId,
  type BlockNavigationDirection,
} from "../../lib/blockNavigation";
import { resolveSourceReadingDirection } from "../../../../shared/translationLanguages";
import type { ShortcutActionId } from "../../../../shared/shortcutSettings";
import { resolveReadingDirection } from "../../../../shared/blockReadingOrder";

type AppSessionShortcutsArgs = {
  chapter: ChapterSessionController;
  translation: TranslationController;
  inpainting: InpaintingController;
};

type StyleSlotActionId = Extract<
  ShortcutActionId,
  `apply-style-slot-${number}`
>;
type FixedShortcutActionId = Exclude<ShortcutActionId, StyleSlotActionId>;
type AppShortcutHandlers = Record<ShortcutActionId, () => void>;
type FixedShortcutHandlers = Record<FixedShortcutActionId, () => void>;

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
  const { blockEditingActions } = translation;
  const { context, editLocked } = resolveShortcutRuntime(
    chapter,
    translation,
    inpainting,
  );

  useSelectedBlockKeyboardNudge({
    blocked: chapter.modalOpen,
    enabled:
      Boolean(derivedState.selectedBlock) &&
      !editLocked &&
      !derivedState.showingOriginalPeek &&
      uiState.showTextBlocks &&
      isBlockEditingTool(uiState.stageTool),
    onNudge: blockEditingActions.nudgeSelectedBlocks,
    workspacePanelRef: core.workspacePanelRef,
  });

  const handlers = createShortcutHandlers({ chapter, inpainting, translation });

  useShortcutDispatcher({
    context,
    handlers,
    holdHandlers: {
      "stage-tool-hand": {
        onPress: () => {
          core.setRegionSelection(null);
          uiState.beginTemporaryHandTool();
        },
        onRelease: uiState.endTemporaryHandTool,
      },
    },
    overrides: chapter.settingsDialog.settings?.keybindings ?? {},
  });
}

export function createShortcutHandlers({
  chapter,
  inpainting,
  translation,
}: AppSessionShortcutsArgs): AppShortcutHandlers {
  const handlers = {
    ...createWorkspaceShortcutHandlers(chapter, inpainting),
    ...createTranslationAndRetouchShortcutHandlers(
      chapter,
      inpainting,
      translation,
    ),
    ...createEditAndGlobalShortcutHandlers(chapter, translation),
  } satisfies FixedShortcutHandlers;
  return {
    ...handlers,
    ...createStyleSlotHandlers(
      chapter,
      translation.blockEditingActions.applyStylePreset,
    ),
  };
}

function createWorkspaceShortcutHandlers(
  chapter: ChapterSessionController,
  inpainting: InpaintingController,
) {
  const { uiState } = chapter;
  const selectStageTool = createStageToolSelector(chapter);
  return {
    "toggle-block-chrome": () => uiState.setShowBlockChrome((value) => !value),
    "toggle-text-blocks": () => uiState.setShowTextBlocks((value) => !value),
    "toggle-peek-original": () => uiState.setPeekOriginal((value) => !value),
    "zoom-in": () => {
      const controller = chapter.core.workspaceZoomControllerRef?.current;
      if (controller) controller.zoomInAtSelection();
      else uiState.zoomInWorkspace();
    },
    "zoom-out": () => {
      const controller = chapter.core.workspaceZoomControllerRef?.current;
      if (controller) controller.zoomOutAtViewport();
      else uiState.zoomOutWorkspace();
    },
    "zoom-reset": () => {
      const controller = chapter.core.workspaceZoomControllerRef?.current;
      if (controller) controller.resetAtViewport();
      else uiState.resetWorkspaceZoom();
    },
    "zoom-fit-contain": () => uiState.setWorkspaceFitMode("contain"),
    "zoom-fit-width": () => uiState.setWorkspaceFitMode("width"),
    "zoom-fit-height": () => uiState.setWorkspaceFitMode("height"),
    "zoom-actual-size": () => uiState.setWorkspaceFitMode("actual"),
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
  };
}

function createTranslationAndRetouchShortcutHandlers(
  chapter: ChapterSessionController,
  inpainting: InpaintingController,
  translation: TranslationController,
) {
  const { uiState } = chapter;
  const { translationActions } = translation;
  return {
    "open-translate-options": () => {
      if (uiState.translateOptionsOpen) {
        uiState.closeTranslateOptions();
      } else {
        uiState.openTranslateOptions();
      }
    },
    "translate-pending": () => void translationActions.runAnalysis("pending"),
    "translate-all": () => void translationActions.runAnalysis("all"),
    "gather-text": () => uiState.setTextViewOpen((open) => !open),
    "cancel-job": () => chapter.bridgeActions.cancelJob(),
    "toggle-inpainting": () => {
      if (uiState.autoInpaintingOptionsOpen) {
        uiState.setAutoInpaintingOptionsOpen(false);
      } else {
        openCurrentPageEraseOptions(chapter);
      }
    },
    "retouch-tool-mask": () => selectRetouchTool(chapter, "mask"),
    "retouch-tool-brush": () => selectRetouchTool(chapter, "brush"),
    "retouch-tool-rectangle": () => selectRetouchTool(chapter, "rectangle"),
    "retouch-tool-ellipse": () => selectRetouchTool(chapter, "ellipse"),
    "retouch-tool-eraser": () => selectRetouchTool(chapter, "eraser"),
    "retouch-tool-eraser-rectangle": () =>
      selectRetouchTool(chapter, "eraser-rectangle"),
    "retouch-tool-picker": () => selectRetouchTool(chapter, "picker"),
    "retouch-apply-mask": () =>
      inpainting.inpaintingBridge.contextValue.onRunDrawnPattern(),
    "retouch-cancel-mask": () => cancelRetouchMask(chapter, inpainting),
  };
}

function createEditAndGlobalShortcutHandlers(
  chapter: ChapterSessionController,
  translation: TranslationController,
) {
  const { core, uiState } = chapter;
  const { blockEditingActions, workspaceHistory } = translation;
  return {
    "block-previous": () => navigateBlock(chapter, "previous"),
    "block-next": () => navigateBlock(chapter, "next"),
    "select-all-blocks": () => selectAllPageBlocks(chapter),
    "move-block-earlier": () =>
      blockEditingActions.moveSelectedBlockInReadingOrder(-1),
    "move-block-later": () =>
      blockEditingActions.moveSelectedBlockInReadingOrder(1),
    "sort-reading-order": () => blockEditingActions.sortPageReadingOrder(),
    "reset-block-rotation": () =>
      blockEditingActions.updateSelectedBlocks({ rotationDeg: 0 }),
    "open-search-replace": () => uiState.setSearchReplaceOpen((open) => !open),
    "open-export-options": () => uiState.setExportOptionsOpen((open) => !open),
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
    "open-settings": () => {
      if (chapter.settingsDialog.settingsOpen) {
        chapter.settingsDialog.closeSettings();
      } else {
        void chapter.settingsDialog.openSettings();
      }
    },
  };
}

function createStageToolSelector(
  chapter: ChapterSessionController,
): (tool: "select" | "block" | "hand") => void {
  return (tool) => {
    chapter.core.setRegionSelection(null);
    chapter.uiState.selectWorkspaceTool(tool);
  };
}

function createStyleSlotHandlers(
  chapter: ChapterSessionController,
  applyStylePreset: (presetId: string) => void,
): Record<StyleSlotActionId, () => void> {
  const handlers = {} as Record<StyleSlotActionId, () => void>;
  for (let slot = 1; slot <= 10; slot += 1) {
    const actionId = `apply-style-slot-${slot}` as StyleSlotActionId;
    handlers[actionId] = () => {
      const preset = chapter.settingsDialog.settings?.blockStylePresets?.find(
        (candidate) => candidate.shortcutSlot === slot,
      );
      if (preset) applyStylePreset(preset.id);
    };
  }
  return handlers;
}

function selectRetouchTool(
  chapter: ChapterSessionController,
  tool: RetouchTool,
): void {
  chapter.core.setRegionSelection(null);
  chapter.uiState.selectWorkspaceTool(tool);
}

function cancelRetouchMask(
  chapter: ChapterSessionController,
  inpainting: InpaintingController,
): void {
  inpainting.inpaintingBridge.contextValue.onClearPatternMask();
  chapter.uiState.selectWorkspaceTool("select");
}

function selectAllPageBlocks(chapter: ChapterSessionController): void {
  const blockIds = chapter.derivedState.selectedPage?.blocks.map(
    (block) => block.id,
  );
  if (!blockIds?.length) {
    return;
  }
  const primaryId = blockIds.includes(chapter.core.selectedBlockId ?? "")
    ? chapter.core.selectedBlockId
    : blockIds[0];
  chapter.core.selectedBlockIdRef.current = primaryId ?? null;
  chapter.core.setSelectedBlockId(primaryId ?? null);
  chapter.core.setSelectedBlockIds(blockIds);
}

function resolveShortcutRuntime(
  chapter: ChapterSessionController,
  translation: TranslationController,
  inpainting: InpaintingController,
): { context: ShortcutContext; editLocked: boolean } {
  const jobActive =
    inpainting.inpaintingBridge.contextValue.jobActive ||
    chapter.uiState.translationFlowActive ||
    translation.workspaceHistory.busy;
  const editLocked =
    chapter.derivedState.selectedPageEditLocked ||
    translation.workspaceHistory.busy;
  return {
    editLocked,
    context: {
      blockingModalOpen: chapter.overlayModalsOpen,
      activeModalActionId: resolveActiveModalActionId(chapter),
      paletteOpen: chapter.uiState.commandPaletteOpen,
      helpOpen: chapter.uiState.shortcutHelpOpen,
      chapterOpen: Boolean(chapter.core.currentChapter),
      editLocked,
      jobActive,
      retouchToolActive: chapter.derivedState.inpaintingToolActive,
      blockSelected: Boolean(chapter.derivedState.selectedBlock),
    },
  };
}

export function resolveActiveModalActionId(
  chapter: ChapterSessionController,
): ShortcutActionId | null {
  const { uiState } = chapter;
  if (chapter.settingsDialog.settingsOpen) return "open-settings";
  if (uiState.translateOptionsOpen) return "open-translate-options";
  if (uiState.textViewOpen) return "gather-text";
  if (uiState.autoInpaintingOptionsOpen) return "toggle-inpainting";
  if (uiState.exportOptionsOpen) return "open-export-options";
  if (uiState.searchReplaceOpen) return "open-search-replace";
  return null;
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
    resolveReadingDirection(
      core.library.works.find((work) => work.id === core.currentChapter?.workId)
        ?.readingDirection,
      resolveSourceReadingDirection(
        chapter.settingsDialog.settings?.translation?.sourceLanguage,
      ),
    ),
    derivedState.selectedPage?.blockOrder,
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
