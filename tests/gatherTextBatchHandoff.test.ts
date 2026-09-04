import { describe, expect, it, vi } from "vitest";
import { createGatherTextProps } from "../src/renderer/src/app/session/createGatherTextProps";
import type { AppSessionViewModel } from "../src/renderer/src/app/session/appSessionViewModel";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

describe("gathered-text to conditional-batch handoff", () => {
  it("opens the destination without dismissing the source immediately", () => {
    const setConditionalBatchInitialFind = vi.fn();
    const setConditionalBatchInitialReplace = vi.fn();
    const setConditionalBatchOpen = vi.fn();
    const setTextViewOpen = vi.fn();
    const props = createGatherTextProps(
      defineFixture<AppSessionViewModel>({
        core: {
          currentChapter: CHAPTER,
          library: { works: [] },
          selectedBlockIdRef: { current: null },
          setSelectedBlockId: vi.fn(),
          setSelectedBlockIds: vi.fn(),
        },
        derivedState: { jobActive: false, selectedPage: PAGE },
        inpaintingBridge: { contextValue: { jobActive: false } },
        libraryActions: { applyChapter: vi.fn() },
        pageNavigationHandlers: { selectPageForReading: vi.fn() },
        settingsDialog: { settings: null },
        uiState: {
          setConditionalBatchInitialFind,
          setConditionalBatchInitialReplace,
          setConditionalBatchOpen,
          setRightRailMode: vi.fn(),
          setTextViewOpen,
          textViewOpen: true,
          translationFlowActive: false,
        },
        updateCurrentChapter: vi.fn(),
        workspaceHistory: { busy: false, reset: vi.fn() },
      }),
    );
    if (!props) throw new Error("gather text props are missing");

    props.onOpenBatchEdit?.("  말줄임표  ");

    expect(setConditionalBatchInitialFind).toHaveBeenCalledWith("말줄임표");
    expect(setConditionalBatchInitialReplace).toHaveBeenCalledWith("");
    expect(setConditionalBatchOpen).toHaveBeenCalledWith(true);
    expect(setTextViewOpen).not.toHaveBeenCalled();
  });

  it("blocks every chapter mutation callback while a workspace job is active", () => {
    const updateCurrentChapter = vi.fn();
    const reset = vi.fn();
    const applyChapter = vi.fn();
    const props = createGatherTextProps(
      defineFixture<AppSessionViewModel>({
        core: {
          currentChapter: CHAPTER,
          library: { works: [] },
          selectedBlockIdRef: { current: null },
          setSelectedBlockId: vi.fn(),
          setSelectedBlockIds: vi.fn(),
        },
        derivedState: {
          jobActive: true,
          selectedPage: PAGE,
          selectedPageEditLocked: false,
        },
        importShareModal: { importBusy: false },
        inpaintingActions: { actionBusy: false },
        inpaintingBridge: { contextValue: { jobActive: true } },
        libraryActions: { applyChapter },
        libraryDrop: { busy: false },
        operationActivity: { active: false },
        pageNavigationHandlers: { selectPageForReading: vi.fn() },
        settingsDialog: { settings: null },
        uiState: {
          setConditionalBatchInitialFind: vi.fn(),
          setConditionalBatchInitialReplace: vi.fn(),
          setConditionalBatchOpen: vi.fn(),
          setRightRailMode: vi.fn(),
          setTextViewOpen: vi.fn(),
          textViewOpen: true,
          translationFlowActive: false,
        },
        updateCurrentChapter,
        workspaceHistory: { busy: false, reset },
      }),
    );
    if (!props) throw new Error("gather text props are missing");

    expect(props.formatApplyDisabled).toBe(true);
    props.onApplyFormat?.({ targets: [], patch: {} });
    props.onApplyTranslatedText?.([
      {
        pageId: PAGE.id,
        blockId: "block-1",
        translatedText: "경합 변경",
      },
    ]);
    props.onChapterUpdated?.(CHAPTER);

    expect(updateCurrentChapter).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(applyChapter).not.toHaveBeenCalled();
  });
});

const PAGE: MangaPage = {
  id: "page-1",
  name: "page-1.png",
  imagePath: "page-1.png",
  dataUrl: "",
  width: 1000,
  height: 1600,
  blocks: [],
  analysisStatus: "completed",
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

const CHAPTER: ChapterSnapshot = {
  id: "chapter-1",
  workId: "work-1",
  title: "1화",
  sourceKind: "images",
  status: "completed",
  pageOrder: [PAGE.id],
  pages: [PAGE],
  createdAt: "2026-09-03T00:00:00.000Z",
  updatedAt: "2026-09-03T00:00:00.000Z",
};

function defineFixture<T>(value: unknown): T {
  return value as T;
}
