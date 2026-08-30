import { describe, expect, it, vi } from "vitest";
import { finishImportedChapterNavigation } from "../src/renderer/src/hooks/importedChapterNavigation";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

describe("background import completion navigation", () => {
  it("leaves the screen alone when the committed chapter is unavailable", async () => {
    const actions = makeActions();

    await finishImportedChapterNavigation({
      ...actions,
      chapter: undefined,
      getNavigationKey: () => "0:chapter-1:page-1",
      navigationKey: "0:chapter-1:page-1",
      openWorkTranslation: false,
    });

    expect(actions.saveNow).not.toHaveBeenCalled();
    expect(actions.applyChapter).not.toHaveBeenCalled();
    expect(actions.pushStatus).toHaveBeenCalledWith("가져오기 완료");
  });

  it("opens the imported chapter only when navigation stayed unchanged", async () => {
    const actions = makeActions();

    await finishImportedChapterNavigation({
      ...actions,
      chapter: makeChapter(),
      getNavigationKey: () => "0:chapter-1:page-1",
      navigationKey: "0:chapter-1:page-1",
      openWorkTranslation: true,
    });

    expect(actions.resetWorkspaceHistory).toHaveBeenCalledOnce();
    expect(actions.applyChapter).toHaveBeenCalledWith(
      expect.objectContaining({ id: "imported-chapter" }),
      "가져오기 완료",
    );
    expect(actions.openTranslateOptions).toHaveBeenCalledWith("work-all");
  });

  it("leaves the current screen alone when the user navigated during the task", async () => {
    const actions = makeActions();

    await finishImportedChapterNavigation({
      ...actions,
      chapter: makeChapter(),
      getNavigationKey: () => "2:chapter-1:page-1",
      navigationKey: "0:chapter-1:page-1",
      openWorkTranslation: false,
    });

    expect(actions.applyChapter).not.toHaveBeenCalled();
    expect(actions.openTranslateOptions).not.toHaveBeenCalled();
    expect(actions.pushStatus).toHaveBeenCalledWith("가져오기 완료");
  });

  it("does not replace the current chapter when saving its edits fails", async () => {
    const actions = makeActions({
      saveNow: vi.fn(async () => {
        throw new Error("save failed");
      }),
    });

    await finishImportedChapterNavigation({
      ...actions,
      chapter: makeChapter(),
      getNavigationKey: () => "0:chapter-1:page-1",
      navigationKey: "0:chapter-1:page-1",
      openWorkTranslation: false,
    });

    expect(actions.applyChapter).not.toHaveBeenCalled();
    expect(actions.openTranslateOptions).not.toHaveBeenCalled();
    expect(actions.pushStatus).toHaveBeenCalledWith("가져오기 완료");
  });
});

function makeActions(
  overrides: Partial<ReturnType<typeof makeActionsBase>> = {},
) {
  return { ...makeActionsBase(), ...overrides };
}

function makeActionsBase() {
  return {
    applyChapter: vi.fn(),
    openTranslateOptions: vi.fn(),
    pushStatus: vi.fn(),
    resetWorkspaceHistory: vi.fn(),
    saveNow: vi.fn(async () => undefined),
    status: "가져오기 완료",
  };
}

function makeChapter(): ChapterSnapshot {
  const timestamp = "2026-08-30T00:00:00.000Z";
  return {
    id: "imported-chapter",
    workId: "work-1",
    title: "가져온 화",
    sourceKind: "pdf",
    status: "idle",
    pageOrder: [],
    pages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
