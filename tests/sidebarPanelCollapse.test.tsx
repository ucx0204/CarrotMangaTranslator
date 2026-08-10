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

describe("sidebar list panel collapse", () => {
  it("lets either list release its height to the other list", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "보관함 접기" }));
    expect(libraryPanel?.getAttribute("data-collapsed")).toBe("true");
    expect(container.querySelector(".library-scroll")).toBeNull();
    expect(container.querySelector(".page-list-scroll")).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "보관함 펼치기" })
        .getAttribute("aria-expanded"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "보관함 펼치기" }));
    fireEvent.click(screen.getByRole("button", { name: "페이지 접기" }));
    expect(pagePanel?.getAttribute("data-collapsed")).toBe("true");
    expect(container.querySelector(".page-list-scroll")).toBeNull();
    expect(container.querySelector(".library-scroll")).not.toBeNull();
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
