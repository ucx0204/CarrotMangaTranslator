/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSidebar } from "../src/renderer/src/components/AppSidebar";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";

afterEach(cleanup);

describe("sidebar list panel switching", () => {
  it("lets each header hide and restore the opposite panel", () => {
    const { container } = render(
      <AppSidebar
        currentChapter={CHAPTER}
        selectedPageId={null}
        library={LIBRARY}
        jobActive={false}
        settingsBusy={false}
        settingsOpen={false}
        onOpenTranslationSource={vi.fn()}
        onOpenBatchImport={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenLibraryFolder={vi.fn()}
        onOpenShareExport={vi.fn()}
        onOpenShareImport={vi.fn()}
        onOpenChapter={vi.fn()}
        onRenameWork={vi.fn()}
        onRenameChapter={vi.fn()}
        onReorderChapter={vi.fn()}
        onSelectPage={vi.fn()}
        onRetranslatePage={vi.fn()}
        onRemovePage={vi.fn()}
        onReorderPage={vi.fn()}
      />,
    );

    const libraryPanel = container.querySelector(".library-panel");
    const pagePanel = container.querySelector(".page-list");
    expect(libraryPanel?.getAttribute("data-collapsed")).toBe("false");
    expect(pagePanel?.getAttribute("data-collapsed")).toBe("false");

    const search = screen.getByRole("textbox", { name: "보관함 검색" });
    fireEvent.change(search, { target: { value: "테스트" } });

    fireEvent.click(screen.getByRole("button", { name: "페이지 접기" }));
    expect(libraryPanel?.getAttribute("data-collapsed")).toBe("false");
    expect(pagePanel?.getAttribute("data-collapsed")).toBe("true");
    expect(pagePanel?.classList.contains("collapsed")).toBe(true);
    expect(
      pagePanel?.querySelector<HTMLElement>(".page-list-content")?.hidden,
    ).toBe(true);
    expect(screen.getByRole("heading", { name: "페이지" })).not.toBeNull();
    expect(container.querySelector(".library-scroll")).not.toBeNull();
    expect(container.querySelector(".page-list-scroll")).not.toBeNull();
    const restorePages = screen.getByRole("button", { name: "페이지 펼치기" });
    expect(restorePages.getAttribute("aria-expanded")).toBe("false");
    expect(
      restorePages.querySelector("svg")?.classList.contains(
        "sidebar-section-collapse-chevron-up",
      ),
    ).toBe(true);

    fireEvent.click(restorePages);
    expect(pagePanel?.getAttribute("data-collapsed")).toBe("false");
    expect((search as HTMLInputElement).value).toBe("테스트");

    fireEvent.click(screen.getByRole("button", { name: "보관함 접기" }));
    expect(libraryPanel?.getAttribute("data-collapsed")).toBe("true");
    expect(pagePanel?.getAttribute("data-collapsed")).toBe("false");
    expect(libraryPanel?.classList.contains("collapsed")).toBe(true);
    expect(
      libraryPanel?.querySelector<HTMLElement>(".library-panel-content")
        ?.hidden,
    ).toBe(true);
    expect(screen.getByRole("heading", { name: "보관함" })).not.toBeNull();
    const restoreLibrary = screen.getByRole("button", {
      name: "보관함 펼치기",
    });
    expect(restoreLibrary.getAttribute("aria-expanded")).toBe("false");
    expect(
      restoreLibrary.querySelector("svg")?.classList.contains(
        "sidebar-section-collapse-chevron-up",
      ),
    ).toBe(false);

    fireEvent.click(restoreLibrary);
    expect(libraryPanel?.getAttribute("data-collapsed")).toBe("false");
    expect(
      (screen.getByRole("textbox", { name: "보관함 검색" }) as HTMLInputElement)
        .value,
    ).toBe("테스트");
  });
});

const TS = "2026-08-10T00:00:00.000Z";

function makePage(number: number): MangaPage {
  return {
    id: `page-${number}`,
    name: `${String(number).padStart(3, "0")}.png`,
    imagePath: `C:/qa/${number}.png`,
    dataUrl:
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    width: 1,
    height: 1,
    blocks: [],
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
  pages: [makePage(1), makePage(2)],
  pageOrder: ["page-1", "page-2"],
  createdAt: TS,
  updatedAt: TS,
};

const LIBRARY: LibraryIndex = {
  workOrder: ["work-1"],
  works: [
    {
      id: "work-1",
      title: "테스트 작품",
      chapterOrder: [CHAPTER.id],
      chapters: [
        {
          id: CHAPTER.id,
          workId: "work-1",
          title: CHAPTER.title,
          status: "completed",
          pageCount: CHAPTER.pages.length,
          createdAt: TS,
          updatedAt: TS,
        },
      ],
      createdAt: TS,
      updatedAt: TS,
    },
  ],
};
