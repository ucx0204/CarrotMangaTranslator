import { describe, expect, it, vi } from "vitest";
import type { AppSessionViewModel } from "../src/renderer/src/app/session/appSessionViewModel";
import { createConditionalBatchEditorProps } from "../src/renderer/src/app/session/createConditionalBatchEditorProps";
import type { AppWorkspaceProps } from "../src/renderer/src/components/appWorkspaceTypes";
import type { UpdateCurrentChapter } from "../src/renderer/src/hooks/useCurrentChapterUpdater";
import { createConditionalBatchPreview } from "../src/shared/conditionalBatchEngine";
import { createEllipsisBatchSchemeDraft } from "../src/shared/conditionalBatchRules";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { TranslationBlock } from "../src/shared/textTypes";

describe("conditional batch editor session binding", () => {
  it("applies every dirty page through one labeled workspace history update", () => {
    const model = createModel();
    const props = createConditionalBatchEditorProps(
      model,
      {} as AppWorkspaceProps,
    );
    if (!props) throw new Error("conditional batch props are missing");

    expect(props.canUndo).toBe(true);
    expect(props.busy).toBe(false);
    props.onClose();
    expect(model.uiState.setConditionalBatchInitialFind).toHaveBeenCalledWith(
      "",
    );
    expect(
      model.uiState.setConditionalBatchInitialReplace,
    ).toHaveBeenCalledWith("");
    expect(model.uiState.setConditionalBatchOpen).toHaveBeenCalledWith(false);
    props.onSelectPage("page-2");
    expect(
      model.pageNavigationHandlers.selectPageForReading,
    ).toHaveBeenCalledWith("page-2");

    const scheme = createEllipsisBatchSchemeDraft();
    const preview = createConditionalBatchPreview(
      CHAPTER,
      { kind: "chapter" },
      scheme,
    );
    expect(props.onApply(scheme, preview, new Set())).toEqual({
      appliedCount: 2,
      conflictCount: 0,
      dirtyPageIds: ["page-1", "page-2"],
    });
    expect(model.updateCurrentChapter).toHaveBeenCalledOnce();
    const [pageId, update, options] = requiredItem(
      model.updateCurrentChapter.mock.calls,
      0,
    );
    expect(pageId).toBe("page-1");
    expect(options).toEqual({
      dirtyPageIds: ["page-1", "page-2"],
      label: "일괄 편집: 말줄임표·공백 정리",
    });
    expect(
      update(CHAPTER).pages.map(
        (page: MangaPage) => page.blocks[0]?.translatedText,
      ),
    ).toEqual(["하나…", "둘…"]);
  });

  it("stays closed without all required session state and does not offer unrelated undo history", () => {
    const closed = createModel({ conditionalBatchOpen: false });
    expect(
      createConditionalBatchEditorProps(closed, {} as AppWorkspaceProps),
    ).toBeNull();

    const noChapter = createModel({ currentChapter: null });
    expect(
      createConditionalBatchEditorProps(noChapter, {} as AppWorkspaceProps),
    ).toBeNull();

    const noPage = createModel({ selectedPage: null });
    expect(
      createConditionalBatchEditorProps(noPage, {} as AppWorkspaceProps),
    ).toBeNull();

    const unrelatedUndo = createModel({ undoLabel: "직접 편집" });
    expect(
      createConditionalBatchEditorProps(unrelatedUndo, {} as AppWorkspaceProps)
        ?.canUndo,
    ).toBe(false);
  });
});

type TestModel = AppSessionViewModel & {
  pageNavigationHandlers: { selectPageForReading: ReturnType<typeof vi.fn> };
  uiState: {
    setConditionalBatchInitialFind: ReturnType<typeof vi.fn>;
    setConditionalBatchInitialReplace: ReturnType<typeof vi.fn>;
    setConditionalBatchOpen: ReturnType<typeof vi.fn>;
  };
  updateCurrentChapter: ReturnType<typeof vi.fn<UpdateCurrentChapter>>;
};

function createModel(
  overrides: {
    conditionalBatchOpen?: boolean;
    currentChapter?: ChapterSnapshot | null;
    selectedPage?: MangaPage | null;
    undoLabel?: string | null;
  } = {},
) {
  const setConditionalBatchOpen = vi.fn();
  const setConditionalBatchInitialFind = vi.fn();
  const setConditionalBatchInitialReplace = vi.fn();
  const selectPageForReading = vi.fn();
  const updateCurrentChapter = vi.fn<UpdateCurrentChapter>();
  return defineFixture<TestModel>({
    core: {
      currentChapter:
        overrides.currentChapter === undefined
          ? CHAPTER
          : overrides.currentChapter,
    },
    derivedState: {
      selectedPage:
        overrides.selectedPage === undefined
          ? CHAPTER.pages[0]
          : overrides.selectedPage,
      selectedPageEditLocked: false,
    },
    libraryDrop: { busy: false },
    pageNavigationHandlers: { selectPageForReading },
    uiState: {
      conditionalBatchInitialFind: "",
      conditionalBatchInitialReplace: "",
      conditionalBatchOpen: overrides.conditionalBatchOpen ?? true,
      setConditionalBatchInitialFind,
      setConditionalBatchInitialReplace,
      setConditionalBatchOpen,
    },
    updateCurrentChapter,
    workspaceHistory: {
      busy: false,
      canUndo: true,
      undo: vi.fn(async () => true),
      undoLabel:
        overrides.undoLabel === undefined
          ? "일괄 편집: 이전 규칙"
          : overrides.undoLabel,
    },
  });
}

const TS = "2026-08-30T00:00:00.000Z";

function makeBlock(id: string, translatedText: string): TranslationBlock {
  return {
    id,
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 300, h: 200 },
    sourceText: id,
    translatedText,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 28,
    lineHeight: 1.3,
    textAlign: "center",
    textColor: "#111111",
    backgroundColor: "#ffffff",
    opacity: 1,
  };
}

function makePage(id: string, translatedText: string): MangaPage {
  const blocks = [makeBlock(`${id}-block`, translatedText)];
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 1000,
    height: 1600,
    blocks,
    blockOrder: blocks.map((block) => block.id),
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}

const CHAPTER: ChapterSnapshot = {
  id: "chapter-1",
  workId: "work-1",
  title: "1화",
  sourceKind: "images",
  status: "completed",
  pageOrder: ["page-1", "page-2"],
  pages: [makePage("page-1", "하나..."), makePage("page-2", "둘...")],
  createdAt: TS,
  updatedAt: TS,
};

function requiredItem<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing fixture item ${index}`);
  return item;
}

function defineFixture<T>(value: unknown): T {
  return value as T;
}
