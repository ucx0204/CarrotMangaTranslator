// @vitest-environment jsdom

import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type {
  ChapterSnapshot,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";
import type {
  PageImageExportPreflightResult,
  PageImageExportRequest,
} from "../src/shared/pageImageExportTypes";

const openChapter = vi.fn<(chapterId: string) => Promise<ChapterSnapshot>>();
const preflightPageImages =
  vi.fn<
    (request: PageImageExportRequest) => Promise<PageImageExportPreflightResult>
  >();

beforeEach(() => {
  preflightPageImages.mockResolvedValue({
    workTitle: "테스트 작품",
    chapterCount: 1,
    pageCount: 1,
    sampleRelativePath: "001-1화\\002-p2.png",
    outputPolicy: "new-timestamped-folder",
    issues: [],
    targets: [],
  });
  window.mangaApi = createTestMangaGatewayStub({
    getPageImageDataUrl: vi.fn(() => Promise.resolve("mgt-image://token")),
    openChapter: (chapterId: string) => openChapter(chapterId),
    preflightPageImages,
  });
});

import { ExportOptionsModal } from "../src/renderer/src/components/ExportOptionsModal";

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

async function renderModal(startResult: boolean) {
  const onStart = vi.fn().mockResolvedValue(startResult);
  const onClose = vi.fn();
  render(
    <ExportOptionsModal
      chapter={makeChapter()}
      currentPageId="p2"
      jobActive={false}
      library={makeLibrary()}
      onStart={onStart}
      onClose={onClose}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  await screen.findByText("출력 가능");
  return { onStart, onClose };
}

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("ExportOptionsModal", () => {
  it("defaults to the current page and stays open when folder selection is cancelled", async () => {
    const { onStart, onClose } = await renderModal(false);

    expect(screen.getByText("테스트 작품")).toBeTruthy();
    expect(screen.getByText("p1.png")).toBeTruthy();
    expect(screen.getByText("p2.png")).toBeTruthy();
    expect(
      (
        screen.getByRole("checkbox", {
          name: "글자 없이 출력",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "PNG 출력" }));

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        [{ chapterId: CHAPTER_ID, mode: "page-set", pageIds: ["p2"] }],
        [],
        { omitText: false },
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes only after a successful export start", async () => {
    const { onClose } = await renderModal(true);

    fireEvent.click(screen.getByRole("button", { name: "PNG 출력" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("preflights and starts a layered PSD export when selected", async () => {
    const { onStart } = await renderModal(false);

    fireEvent.click(screen.getByRole("combobox", { name: "파일 형식" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "파일 형식" })).getByRole(
        "option",
        { name: "레이어 문서 (PSD)" },
      ),
    );

    await waitFor(() =>
      expect(preflightPageImages).toHaveBeenLastCalledWith(
        expect.objectContaining({ outputFormat: "psd" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "PSD 출력" }));

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        [{ chapterId: CHAPTER_ID, mode: "page-set", pageIds: ["p2"] }],
        [],
        { omitText: false, outputFormat: "psd" },
      ),
    );
  });

  it("supports current chapter, all, and clear quick selections", async () => {
    const { onStart } = await renderModal(false);
    const exportButton = screen.getByRole("button", { name: "PNG 출력" });

    fireEvent.click(screen.getByRole("button", { name: "전체 선택" }));
    await waitFor(() => expect(exportButton).toHaveProperty("disabled", false));
    fireEvent.click(exportButton);
    await waitFor(() =>
      expect(onStart).toHaveBeenLastCalledWith(
        [
          { chapterId: CHAPTER_ID, mode: "all" },
          { chapterId: SECOND_CHAPTER_ID, mode: "all" },
        ],
        [],
        { omitText: false },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "현재 화" }));
    await waitFor(() => expect(exportButton).toHaveProperty("disabled", false));
    fireEvent.click(exportButton);
    await waitFor(() =>
      expect(onStart).toHaveBeenLastCalledWith(
        [{ chapterId: CHAPTER_ID, mode: "all" }],
        [],
        { omitText: false },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    expect(screen.getByRole("button", { name: "PNG 출력" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("loads another chapter only when it is expanded", async () => {
    openChapter.mockResolvedValue(
      makeChapter(SECOND_CHAPTER_ID, [makePage("p3"), makePage("p4")]),
    );
    await renderModal(false);

    expect(openChapter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /2화/ }));

    await waitFor(() =>
      expect(openChapter).toHaveBeenCalledWith(SECOND_CHAPTER_ID),
    );
    expect(await screen.findByText("p3.png")).toBeTruthy();
  });

  it("shows preflight warnings and can navigate to the affected page", async () => {
    const onNavigateToIssue = vi.fn();
    preflightPageImages.mockResolvedValueOnce({
      workTitle: "테스트 작품",
      chapterCount: 1,
      pageCount: 1,
      sampleRelativePath: "001-1화\\002-p2.png",
      outputPolicy: "new-timestamped-folder",
      issues: [
        {
          code: "postprocess-pending",
          severity: "warning",
          chapterId: CHAPTER_ID,
          chapterTitle: "1화",
          pageId: "p2",
          pageName: "p2.png",
        },
      ],
      targets: [],
    });
    render(
      <ExportOptionsModal
        chapter={makeChapter()}
        currentPageId="p2"
        jobActive={false}
        library={makeLibrary()}
        onStart={vi.fn().mockResolvedValue(false)}
        onNavigateToIssue={onNavigateToIssue}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByText("경고 1개")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "페이지 보기" }));
    expect(onNavigateToIssue).toHaveBeenCalledWith(CHAPTER_ID, "p2");
  });

  it("exports only the inpainted background when textless output is enabled", async () => {
    const { onStart } = await renderModal(false);

    fireEvent.click(screen.getByRole("checkbox", { name: "글자 없이 출력" }));

    await waitFor(() =>
      expect(preflightPageImages).toHaveBeenLastCalledWith(
        expect.objectContaining({ omitText: true }),
      ),
    );
    const exportButton = screen.getByRole("button", { name: "PNG 출력" });
    await waitFor(() => expect(exportButton).toHaveProperty("disabled", false));
    fireEvent.click(exportButton);

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        [{ chapterId: CHAPTER_ID, mode: "page-set", pageIds: ["p2"] }],
        [],
        { omitText: true },
      ),
    );
  });

  it("blocks textless output when an inpainted image is unavailable", async () => {
    preflightPageImages.mockImplementation(async (request) => ({
      workTitle: "테스트 작품",
      chapterCount: 1,
      pageCount: 1,
      sampleRelativePath: "001-1화\\002-p2.png",
      outputPolicy: "new-timestamped-folder",
      issues: request.omitText
        ? [
            {
              code: "inpainted-image-missing",
              severity: "warning",
              chapterId: CHAPTER_ID,
              chapterTitle: "1화",
              pageId: "p2",
              pageName: "p2.png",
            },
          ]
        : [],
      targets: [],
    }));
    await renderModal(false);

    fireEvent.click(screen.getByRole("checkbox", { name: "글자 없이 출력" }));

    expect(
      await screen.findByText(
        "인페인팅 결과가 없어 글자 없는 출력을 만들 수 없습니다.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "PNG 출력" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
