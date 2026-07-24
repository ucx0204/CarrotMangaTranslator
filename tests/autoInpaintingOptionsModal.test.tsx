// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";

const openChapter = vi.fn<(chapterId: string) => Promise<ChapterSnapshot>>();

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    getPageImageDataUrl: vi.fn(() => Promise.resolve("mgt-image://token")),
    openChapter: (chapterId: string) => openChapter(chapterId),
  });
});

import { AutoInpaintingOptionsModal } from "../src/renderer/src/components/AutoInpaintingOptionsModal";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_CHAPTER_ID = "33333333-3333-4333-8333-333333333333";
const TS = "2026-01-01T00:00:00.000Z";

function makePage(id: string): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `C:/${id}.png`,
    dataUrl: "",
    width: 100,
    height: 150,
    blocks: [],
    analysisStatus: "completed",
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeChapter(
  id = CHAPTER_ID,
  pages = [makePage("p1"), makePage("p2")],
): ChapterSnapshot {
  return {
    id,
    workId: WORK_ID,
    title: id === CHAPTER_ID ? "1화" : "2화",
    sourceKind: "images",
    status: "completed",
    pageOrder: pages.map((page) => page.id),
    pages,
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeLibrary(): LibraryIndex {
  return {
    workOrder: [WORK_ID],
    works: [
      {
        id: WORK_ID,
        title: "테스트 작품",
        chapterOrder: [CHAPTER_ID, SECOND_CHAPTER_ID],
        createdAt: TS,
        updatedAt: TS,
        chapters: [
          {
            id: CHAPTER_ID,
            workId: WORK_ID,
            title: "1화",
            status: "completed",
            createdAt: TS,
            updatedAt: TS,
            pageCount: 2,
          },
          {
            id: SECOND_CHAPTER_ID,
            workId: WORK_ID,
            title: "2화",
            status: "completed",
            createdAt: TS,
            updatedAt: TS,
            pageCount: 2,
          },
        ],
      },
    ],
  };
}

async function renderModal() {
  const onStart = vi.fn();
  const onClose = vi.fn();
  render(
    <AutoInpaintingOptionsModal
      chapter={makeChapter()}
      currentPageId="p2"
      library={makeLibrary()}
      onStart={onStart}
      onClose={onClose}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { onStart, onClose };
}

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("AutoInpaintingOptionsModal", () => {
  it("defaults to the current page and submits all/page-set selections", async () => {
    const { onStart, onClose } = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: "자동 지우기 시작" }));

    expect(onStart).toHaveBeenCalledWith([
      { chapterId: CHAPTER_ID, mode: "page-set", pageIds: ["p2"] },
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("supports whole-work and clear quick actions", async () => {
    const { onStart } = await renderModal();

    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    fireEvent.click(screen.getByRole("button", { name: "자동 지우기 시작" }));
    expect(onStart).toHaveBeenCalledWith([
      { chapterId: CHAPTER_ID, mode: "all" },
      { chapterId: SECOND_CHAPTER_ID, mode: "all" },
    ]);

    cleanup();
    await renderModal();
    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    expect(
      screen.getByRole("button", { name: "자동 지우기 시작" }),
    ).toHaveProperty("disabled", true);
  });

  it("loads pages for another chapter only when expanded", async () => {
    openChapter.mockResolvedValue(
      makeChapter(SECOND_CHAPTER_ID, [makePage("p3"), makePage("p4")]),
    );
    await renderModal();

    expect(openChapter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /2화/ }));

    await waitFor(() =>
      expect(openChapter).toHaveBeenCalledWith(SECOND_CHAPTER_ID),
    );
    expect(await screen.findByText("p3.png")).toBeTruthy();
  });
});
