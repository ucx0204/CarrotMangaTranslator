/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createShortcutHandlers,
  resolveActiveModalActionId,
} from "../src/renderer/src/app/session/useAppSessionShortcuts";
import { useAppSessionUiState } from "../src/renderer/src/app/session/useAppSessionUiState";
import { SHORTCUT_ACTION_IDS } from "../src/shared/shortcutSettings";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import type { WorkspaceZoomController } from "../src/renderer/src/lib/workspaceZoom";

describe("app-session shortcut handlers", () => {
  it("provides a concrete runtime handler for every registered shortcut", () => {
    const spies = makeSpies();
    const { result } = renderShortcutHarness(spies);

    expect(Object.keys(result.current.handlers).sort()).toEqual(
      [...SHORTCUT_ACTION_IDS].sort(),
    );
    for (const actionId of SHORTCUT_ACTION_IDS) {
      expect(typeof result.current.handlers[actionId]).toBe("function");
    }
  });

  it("changes the real app UI state for view, tool, and modal shortcuts", () => {
    const spies = makeSpies();
    const { result } = renderShortcutHarness(spies);

    run(result, "toggle-block-chrome");
    expect(result.current.uiState.showBlockChrome).toBe(false);
    run(result, "toggle-text-blocks");
    expect(result.current.uiState.showTextBlocks).toBe(false);
    run(result, "toggle-peek-original");
    expect(result.current.uiState.peekOriginal).toBe(true);

    run(result, "stage-tool-block");
    expect(result.current.uiState.stageTool).toBe("block");
    run(result, "stage-tool-hand");
    expect(result.current.uiState.stageTool).toBe("hand");
    run(result, "retouch-tool-mask");
    expect(result.current.uiState.stageTool).toBe("mask");
    run(result, "retouch-tool-brush");
    expect(result.current.uiState.stageTool).toBe("brush");
    run(result, "retouch-tool-rectangle");
    expect(result.current.uiState.stageTool).toBe("rectangle");
    run(result, "retouch-tool-ellipse");
    expect(result.current.uiState.stageTool).toBe("ellipse");
    run(result, "retouch-tool-eraser");
    expect(result.current.uiState.stageTool).toBe("eraser");
    run(result, "retouch-tool-eraser-rectangle");
    expect(result.current.uiState.stageTool).toBe("eraser-rectangle");
    run(result, "retouch-tool-picker");
    expect(result.current.uiState.stageTool).toBe("picker");
    run(result, "stage-tool-select");
    expect(result.current.uiState.stageTool).toBe("select");

    run(result, "toggle-stage-toolbar");
    expect(result.current.uiState.stageToolbarHidden).toBe(true);
    run(result, "zoom-in");
    expect(result.current.uiState.workspaceZoom).toBeGreaterThan(1);
    run(result, "zoom-reset");
    expect(result.current.uiState.workspaceZoom).toBe(1);
    run(result, "zoom-fit-width");
    expect(result.current.uiState.workspaceFitMode).toBe("width");
    run(result, "zoom-fit-height");
    expect(result.current.uiState.workspaceFitMode).toBe("height");
    run(result, "zoom-actual-size");
    expect(result.current.uiState.workspaceFitMode).toBe("actual");
    run(result, "zoom-fit-contain");
    expect(result.current.uiState.workspaceFitMode).toBe("contain");

    expectToggle(result, "open-search-replace", "searchReplaceOpen");
    expectToggle(result, "open-export-options", "exportOptionsOpen");
    expectToggle(result, "gather-text", "textViewOpen");
    expectToggle(result, "open-translate-options", "translateOptionsOpen");
    expectToggle(result, "toggle-inpainting", "autoInpaintingOptionsOpen");
    expectToggle(result, "toggle-command-palette", "commandPaletteOpen");
    expectToggle(result, "toggle-shortcut-help", "shortcutHelpOpen");
  });

  it("routes every controller-backed action to its production operation", () => {
    const spies = makeSpies();
    const { result } = renderShortcutHarness(spies);

    run(result, "page-previous");
    expect(spies.selectAdjacentPage).toHaveBeenCalledWith("previous");
    run(result, "page-next");
    expect(spies.selectAdjacentPage).toHaveBeenCalledWith("next");
    run(result, "translate-pending");
    expect(spies.runAnalysis).toHaveBeenCalledWith("pending");
    run(result, "translate-all");
    expect(spies.runAnalysis).toHaveBeenCalledWith("all");
    run(result, "cancel-job");
    expect(spies.cancelJob).toHaveBeenCalledOnce();
    run(result, "retouch-apply-mask");
    expect(spies.runDrawnPattern).toHaveBeenCalledOnce();
    run(result, "retouch-cancel-mask");
    expect(spies.clearPatternMask).toHaveBeenCalledOnce();

    run(result, "select-all-blocks");
    expect(spies.setSelectedBlockIds).toHaveBeenCalledWith([
      "block-a",
      "block-b",
      "block-c",
    ]);
    run(result, "move-block-earlier");
    expect(spies.moveReadingOrder).toHaveBeenCalledWith(-1);
    run(result, "move-block-later");
    expect(spies.moveReadingOrder).toHaveBeenCalledWith(1);
    run(result, "sort-reading-order");
    expect(spies.sortReadingOrder).toHaveBeenCalledOnce();
    run(result, "reset-block-rotation");
    expect(spies.updateSelectedBlocks).toHaveBeenCalledWith({
      rotationDeg: 0,
    });
    run(result, "history-undo");
    expect(spies.undo).toHaveBeenCalledOnce();
    run(result, "history-redo");
    expect(spies.redo).toHaveBeenCalledOnce();
    run(result, "delete-block");
    expect(spies.deleteBlock).toHaveBeenCalledOnce();
    run(result, "duplicate-block");
    expect(spies.duplicateBlock).toHaveBeenCalledOnce();
    run(result, "toggle-block-excluded");
    expect(spies.toggleExcluded).toHaveBeenCalledWith("block-b");
    run(result, "apply-style-slot-1");
    expect(spies.applyStylePreset).toHaveBeenCalledWith("preset-one");
  });

  it("uses the toolbar anchor rules for keyboard zoom shortcuts", () => {
    const spies = makeSpies();
    const controller: WorkspaceZoomController = {
      resetAtViewport: vi.fn(),
      zoomAtPointer: vi.fn(),
      zoomInAtSelection: vi.fn(),
      zoomOutAtViewport: vi.fn(),
    };
    const { result } = renderShortcutHarness(spies, false, controller);

    run(result, "zoom-in");
    run(result, "zoom-out");
    run(result, "zoom-reset");

    expect(controller.zoomInAtSelection).toHaveBeenCalledOnce();
    expect(controller.zoomOutAtViewport).toHaveBeenCalledOnce();
    expect(controller.resetAtViewport).toHaveBeenCalledOnce();
  });

  it("uses the same settings shortcut to open and close settings", () => {
    const spies = makeSpies();
    const harness = renderShortcutHarness(spies, false);

    run(harness.result, "open-settings");
    expect(spies.openSettings).toHaveBeenCalledOnce();
    expect(spies.closeSettings).not.toHaveBeenCalled();

    harness.rerender({ settingsOpen: true });
    run(harness.result, "open-settings");
    expect(spies.closeSettings).toHaveBeenCalledOnce();
  });

  it("identifies every shortcut-owned blocking modal", () => {
    const cases = [
      ["settingsOpen", "open-settings"],
      ["translateOptionsOpen", "open-translate-options"],
      ["textViewOpen", "gather-text"],
      ["autoInpaintingOptionsOpen", "toggle-inpainting"],
      ["exportOptionsOpen", "open-export-options"],
      ["searchReplaceOpen", "open-search-replace"],
    ] as const;
    for (const [stateKey, actionId] of cases) {
      const uiState = {
        autoInpaintingOptionsOpen: false,
        exportOptionsOpen: false,
        searchReplaceOpen: false,
        textViewOpen: false,
        translateOptionsOpen: false,
      };
      const settingsDialog = { settingsOpen: false };
      if (stateKey === "settingsOpen") {
        settingsDialog.settingsOpen = true;
      } else {
        uiState[stateKey] = true;
      }
      expect(
        resolveActiveModalActionId({ settingsDialog, uiState } as never),
      ).toBe(actionId);
    }
  });
});

type ShortcutHarness = ReturnType<typeof useShortcutHarness>;
type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number];

function renderShortcutHarness(
  spies: TestSpies,
  settingsOpen = false,
  workspaceZoomController: WorkspaceZoomController | null = null,
) {
  return renderHook(
    ({ settingsOpen: open }) =>
      useShortcutHarness(spies, open, workspaceZoomController),
    { initialProps: { settingsOpen } },
  );
}

function useShortcutHarness(
  spies: TestSpies,
  settingsOpen: boolean,
  workspaceZoomController: WorkspaceZoomController | null,
): {
  handlers: ReturnType<typeof createShortcutHandlers>;
  uiState: ReturnType<typeof useAppSessionUiState>;
} {
  const uiState = useAppSessionUiState();
  const chapter = makeChapterController(
    uiState,
    spies,
    settingsOpen,
    workspaceZoomController,
  );
  const translation = makeTranslationController(spies);
  const inpainting = makeInpaintingController(spies);
  return {
    handlers: createShortcutHandlers({ chapter, translation, inpainting }),
    uiState,
  };
}

function run(
  result: { current: ShortcutHarness },
  actionId: ShortcutActionId,
): void {
  act(() => result.current.handlers[actionId]());
}

function expectToggle(
  result: { current: ShortcutHarness },
  actionId: ShortcutActionId,
  stateKey:
    | "autoInpaintingOptionsOpen"
    | "commandPaletteOpen"
    | "exportOptionsOpen"
    | "searchReplaceOpen"
    | "shortcutHelpOpen"
    | "textViewOpen"
    | "translateOptionsOpen",
): void {
  run(result, actionId);
  expect(result.current.uiState[stateKey], `${actionId} must open`).toBe(true);
  run(result, actionId);
  expect(result.current.uiState[stateKey], `${actionId} must close`).toBe(
    false,
  );
}

function makeChapterController(
  uiState: ReturnType<typeof useAppSessionUiState>,
  spies: TestSpies,
  settingsOpen: boolean,
  workspaceZoomController: WorkspaceZoomController | null,
) {
  const chapter = makeChapter();
  const selectedPage = chapter.pages[0] ?? null;
  return {
    bridgeActions: { cancelJob: spies.cancelJob },
    core: {
      currentChapter: chapter,
      library: {
        works: [{ id: "work-1", readingDirection: "ltr" }],
      },
      selectedBlockId: "block-b",
      selectedBlockIdRef: { current: "block-b" },
      workspaceZoomControllerRef: { current: workspaceZoomController },
      setRegionSelection: spies.setRegionSelection,
      setSelectedBlockId: spies.setSelectedBlockId,
      setSelectedBlockIds: spies.setSelectedBlockIds,
    },
    derivedState: {
      selectedBlock: selectedPage?.blocks[1] ?? null,
      selectedPage,
    },
    settingsDialog: {
      closeSettings: spies.closeSettings,
      openSettings: spies.openSettings,
      settings: {
        blockStylePresets: [{ id: "preset-one", shortcutSlot: 1 }],
        translation: { sourceLanguage: "ja" },
      },
      settingsOpen,
    },
    uiState,
  } as never;
}

function makeTranslationController(spies: TestSpies) {
  return {
    blockEditingActions: {
      applyStylePreset: spies.applyStylePreset,
      deleteSelectedBlock: spies.deleteBlock,
      duplicateSelectedBlock: spies.duplicateBlock,
      moveSelectedBlockInReadingOrder: spies.moveReadingOrder,
      nudgeSelectedBlocks: vi.fn(),
      sortPageReadingOrder: spies.sortReadingOrder,
      toggleBlockInpaintExcluded: spies.toggleExcluded,
      updateSelectedBlocks: spies.updateSelectedBlocks,
    },
    translationActions: { runAnalysis: spies.runAnalysis },
    workspaceHistory: { redo: spies.redo, undo: spies.undo },
  } as never;
}

function makeInpaintingController(spies: TestSpies) {
  return {
    inpaintingBridge: {
      contextValue: {
        onClearPatternMask: spies.clearPatternMask,
        onRunDrawnPattern: spies.runDrawnPattern,
      },
    },
    pageNavigationHandlers: {
      selectAdjacentPageForReading: spies.selectAdjacentPage,
    },
  } as never;
}

type TestSpies = ReturnType<typeof makeSpies>;

function makeSpies() {
  return {
    applyStylePreset: vi.fn(),
    cancelJob: vi.fn(),
    clearPatternMask: vi.fn(),
    closeSettings: vi.fn(),
    deleteBlock: vi.fn(),
    duplicateBlock: vi.fn(),
    moveReadingOrder: vi.fn(),
    openSettings: vi.fn(async () => undefined),
    redo: vi.fn(async () => undefined),
    runAnalysis: vi.fn(),
    runDrawnPattern: vi.fn(),
    selectAdjacentPage: vi.fn(),
    setRegionSelection: vi.fn(),
    setSelectedBlockId: vi.fn(),
    setSelectedBlockIds: vi.fn(),
    sortReadingOrder: vi.fn(),
    toggleExcluded: vi.fn(),
    undo: vi.fn(async () => undefined),
    updateSelectedBlocks: vi.fn(),
  };
}

function makeChapter(): ChapterSnapshot {
  const now = "2026-08-11T00:00:00.000Z";
  const page = makePage(
    "page-1",
    ["block-a", "block-b", "block-c"].map(makeBlock),
  );
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "Shortcut QA",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [page],
    createdAt: now,
    updatedAt: now,
  };
}

function makePage(id: string, blocks: TranslationBlock[]): MangaPage {
  const now = "2026-08-11T00:00:00.000Z";
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks,
    analysisStatus: "idle",
    createdAt: now,
    updatedAt: now,
  };
}

function makeBlock(id: string): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 100 },
    sourceText: id,
    translatedText: id,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 24,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 0.2,
  };
}
