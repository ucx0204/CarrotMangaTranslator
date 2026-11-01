/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryTree } from "../src/renderer/src/components/LibraryTree";
import {
  COLLAPSED_WORK_IDS_STORAGE_KEY,
  normalizeCollapsedWorkIds,
  pruneCollapsedWorkIds,
} from "../src/renderer/src/lib/libraryWorkDisclosure";
import type {
  LibraryChapterSummary,
  LibraryIndex,
} from "../src/shared/libraryTypes";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("library work disclosure", () => {
  it("allows keyboard drag cancellation after expanding a folded work", async () => {
    seedCollapsed(["work-a"]);
    const onReorderChapter = vi.fn();
    renderTree({ onReorderChapter });
    fireEvent.click(workToggle("Alpha"));
    const handle = screen.getByRole("button", { name: "A-1 순서 이동" });
    handle.focus();
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    await waitFor(() =>
      expect(
        document.querySelector(".library-scroll.drag-active"),
      ).not.toBeNull(),
    );
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(document.querySelector(".library-scroll.drag-active")).toBeNull(),
    );
    expect(onReorderChapter).not.toHaveBeenCalled();
    expect(isExpanded("Alpha")).toBe(true);
  });

  it("starts expanded, folds one work and restores the fold after remount", () => {
    const view = renderTree();
    expect(isExpanded("Alpha")).toBe(true);
    expect(isExpanded("Beta")).toBe(true);

    fireEvent.click(workToggle("Alpha"));
    expect(isExpanded("Alpha")).toBe(false);
    expect(screen.queryByText("A-1")).toBeNull();
    expect(screen.getByText("B-1")).not.toBeNull();
    expect(screen.getByText("2개 화")).not.toBeNull();
    expect(storedIds()).toEqual(["work-a"]);

    view.unmount();
    renderTree();
    expect(isExpanded("Alpha")).toBe(false);
    expect(isExpanded("Beta")).toBe(true);
  });

  it("collapses and expands every work with separate buttons", () => {
    renderTree();
    const collapseAll = bulkButton("모든 작품 접기");
    const expandAll = bulkButton("모든 작품 펼치기");
    expect(expandAll.disabled).toBe(true);

    fireEvent.click(collapseAll);
    expect([isExpanded("Alpha"), isExpanded("Beta")]).toEqual([false, false]);
    expect(storedIds()).toEqual(["work-a", "work-b"]);
    expect(collapseAll.disabled).toBe(true);

    fireEvent.click(expandAll);
    expect([isExpanded("Alpha"), isExpanded("Beta")]).toEqual([true, true]);
    expect(storedIds()).toEqual([]);
  });

  it("expands matches during search without touching the saved layout", () => {
    seedCollapsed(["work-a", "work-b"]);
    renderTree();
    search("A-");

    expect(isExpanded("Alpha")).toBe(true);
    expect(screen.getByText("A-1")).not.toBeNull();
    expect(
      bulkButton("모든 작품 접기 · 검색어를 지우면 사용할 수 있습니다")
        .disabled,
    ).toBe(true);
    expect(
      bulkButton("모든 작품 펼치기 · 검색어를 지우면 사용할 수 있습니다")
        .disabled,
    ).toBe(true);

    fireEvent.click(workToggle("Alpha"));
    expect(isExpanded("Alpha")).toBe(false);
    expect(storedIds()).toEqual(["work-a", "work-b"]);

    search("");
    expect([isExpanded("Alpha"), isExpanded("Beta")]).toEqual([false, false]);
    search("A-");
    expect(isExpanded("Alpha")).toBe(true);
  });

  it("reveals a work only for navigation to a different chapter", () => {
    const view = renderTree({ currentChapterId: "a1" });
    fireEvent.click(workToggle("Alpha"));
    rerender(view, { currentChapterId: "a1", library: makeLibrary() });
    expect(isExpanded("Alpha")).toBe(false);

    fireEvent.click(workToggle("Beta"));
    rerender(view, { currentChapterId: "b1" });
    expect(isExpanded("Beta")).toBe(true);
    expect(isExpanded("Alpha")).toBe(false);
    expect(storedIds()).toEqual(["work-a"]);
  });

  it("reveals a navigated chapter once a later library read lists it", () => {
    seedCollapsed(["work-b"]);
    const view = renderTree({ currentChapterId: "a1" });
    rerender(view, { currentChapterId: "b-new" });
    expect(isExpanded("Beta")).toBe(false);

    rerender(view, {
      currentChapterId: "b-new",
      library: makeLibrary({ extraBetaChapter: "b-new" }),
    });
    expect(isExpanded("Beta")).toBe(true);
  });

  it("reveals a work that gains a chapter but not one that only refreshes", () => {
    seedCollapsed(["work-a", "work-b"]);
    const view = renderTree();
    rerender(view, { library: makeLibrary({ betaStatus: "running" }) });
    expect([isExpanded("Alpha"), isExpanded("Beta")]).toEqual([false, false]);

    rerender(view, { library: makeLibrary({ extraBetaChapter: "b3" }) });
    expect(isExpanded("Beta")).toBe(true);
    expect(isExpanded("Alpha")).toBe(false);
  });

  it("keeps saved folds until a complete library read proves removal", () => {
    seedCollapsed(["work-a", "work-gone"]);
    const view = renderTree({ library: { workOrder: [], works: [] } });
    rerender(view, { library: makeLibrary() });
    expect(storedIds()).toEqual(["work-a", "work-gone"]);

    rerender(view, { library: makeLibrary(), libraryComplete: true });
    expect(storedIds()).toEqual(["work-a"]);
    expect(isExpanded("Alpha")).toBe(false);
  });

  it("keeps same-work reordering enabled only outside search", () => {
    renderTree();
    const handle = screen.getByRole("button", { name: "A-1 순서 이동" });
    expect((handle as HTMLButtonElement).disabled).toBe(false);
    search("A-");
    expect(
      (
        screen.getByRole("button", {
          name: "A-1 순서 이동",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

describe("collapsed work id storage", () => {
  it("normalizes corrupt entries and prunes against a complete library", () => {
    expect(normalizeCollapsedWorkIds("work-a")).toEqual([]);
    expect(
      normalizeCollapsedWorkIds(["work-a", "", 3, "work-a", "x".repeat(201)]),
    ).toEqual(["work-a"]);
    const ids = new Set(["work-a", "work-gone"]);
    expect([...pruneCollapsedWorkIds(ids, makeLibrary())]).toEqual(["work-a"]);
    const kept = new Set(["work-a"]);
    expect(pruneCollapsedWorkIds(kept, makeLibrary())).toBe(kept);
  });

  it("treats unreadable storage as all expanded", () => {
    window.localStorage.setItem(COLLAPSED_WORK_IDS_STORAGE_KEY, "{broken");
    renderTree();
    expect(isExpanded("Alpha")).toBe(true);
  });
});

type TreeOverrides = Partial<React.ComponentProps<typeof LibraryTree>>;

function renderTree(overrides: TreeOverrides = {}) {
  return render(<LibraryTree {...makeTreeProps(overrides)} />);
}

function rerender(
  view: ReturnType<typeof renderTree>,
  overrides: TreeOverrides,
): void {
  view.rerender(<LibraryTree {...makeTreeProps(overrides)} />);
}

const SHARED_CALLBACKS = {
  onOpenChapter: vi.fn(),
  onRenameChapter: vi.fn(),
  onRenameWork: vi.fn(),
  onReorderChapter: vi.fn(),
  onToggleOtherPanel: vi.fn(),
};

function makeTreeProps(
  overrides: TreeOverrides,
): React.ComponentProps<typeof LibraryTree> {
  return {
    collapsed: false,
    currentChapterId: null,
    jobActive: false,
    library: makeLibrary(),
    otherPanelCollapsed: false,
    ...SHARED_CALLBACKS,
    ...overrides,
  };
}

function workToggle(title: string): HTMLElement {
  const toggle = screen
    .getByText(title, { selector: "strong" })
    .closest<HTMLElement>("button[aria-expanded]");
  if (!toggle) throw new Error(`No disclosure for ${title}`);
  return toggle;
}

function isExpanded(title: string): boolean {
  return workToggle(title).getAttribute("aria-expanded") === "true";
}

function bulkButton(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function search(value: string): void {
  fireEvent.change(screen.getByRole("textbox", { name: "보관함 검색" }), {
    target: { value },
  });
}

function seedCollapsed(ids: string[]): void {
  window.localStorage.setItem(
    COLLAPSED_WORK_IDS_STORAGE_KEY,
    JSON.stringify(ids),
  );
}

function storedIds(): string[] {
  return JSON.parse(
    window.localStorage.getItem(COLLAPSED_WORK_IDS_STORAGE_KEY) ?? "[]",
  ) as string[];
}

const TS = "2026-10-13T00:00:00.000Z";

function makeLibrary({
  betaStatus = "completed",
  extraBetaChapter,
}: {
  betaStatus?: LibraryChapterSummary["status"];
  extraBetaChapter?: string;
} = {}): LibraryIndex {
  const beta = [
    chapter("b1", "work-b", "B-1", betaStatus),
    ...(extraBetaChapter
      ? [chapter(extraBetaChapter, "work-b", extraBetaChapter, "idle")]
      : []),
  ];
  return {
    workOrder: ["work-a", "work-b"],
    works: [
      work("work-a", "Alpha", [
        chapter("a1", "work-a", "A-1", "completed"),
        chapter("a2", "work-a", "A-2", "idle"),
      ]),
      work("work-b", "Beta", beta),
    ],
  };
}

function work(
  id: string,
  title: string,
  chapters: LibraryChapterSummary[],
): LibraryIndex["works"][number] {
  return {
    id,
    title,
    chapterOrder: chapters.map((entry) => entry.id),
    chapters,
    createdAt: TS,
    updatedAt: TS,
  };
}

function chapter(
  id: string,
  workId: string,
  title: string,
  status: LibraryChapterSummary["status"],
): LibraryChapterSummary {
  return {
    id,
    workId,
    title,
    status,
    pageCount: 3,
    createdAt: TS,
    updatedAt: TS,
  };
}
