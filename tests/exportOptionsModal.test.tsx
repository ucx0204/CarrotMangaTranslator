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
  ChapterPageMetadata,
  LibraryIndex,
  MangaPage,
} from "../src/shared/libraryTypes";
import type {
  PageImageExportPreflightResult,
  PageExportSelectionRequest,
} from "../src/shared/pageImageExportTypes";
import type { ExportPreferences } from "../src/shared/exportPreferences";
import { chooseCustomSelectOption } from "./testUtils/customSelect";

const openChapter = vi.fn<(chapterId: string) => Promise<ChapterSnapshot>>();
const getChapterPageMetadata =
  vi.fn<
    (workId: string, chapterId: string) => Promise<ChapterPageMetadata[]>
  >();
const preflightPageImages =
  vi.fn<
    (
      request: PageExportSelectionRequest,
    ) => Promise<PageImageExportPreflightResult>
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
    getChapterPageMetadata,
  });
});

import { ExportOptionsModal } from "../src/renderer/src/components/ExportOptionsModal";

const WORK_ID = "11111111-1111-4111-8111-111111111111";
const CHAPTER_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_CHAPTER_ID = "33333333-3333-4333-8333-333333333333";
const TS = "2026-01-01T00:00:00.000Z";
const DEFAULT_RASTER_OPTIONS = {
  outputFormat: "source",
  jpegQuality: 95,
  webpQuality: 90,
  preserveSourceNames: true,
  destinationMode: "timestamped",
  // Every opening starts from the non-destructive collision choice.
  collisionPolicy: "cancel",
} as const;

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

function makeLibrary(currentPageCount = 2): LibraryIndex {
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
            pageCount: currentPageCount,
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

async function renderModal(
  startResult: boolean,
  kind: "raster" | "psd" = "raster",
  currentChapter = makeChapter(),
) {
  const onStart = vi.fn().mockResolvedValue(startResult);
  const onClose = vi.fn();
  render(
    <ExportOptionsModal
      chapter={currentChapter}
      currentPageId="p2"
      jobActive={false}
      kind={kind}
      library={makeLibrary(currentChapter.pages.length)}
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
  it("defaults to the whole chapter and stays open when folder selection is cancelled", async () => {
    const { onStart, onClose } = await renderModal(false);

    expect(screen.getByRole("dialog", { name: "결과물 출력" })).toBeTruthy();
    expect(screen.getByText("테스트 작품")).toBeTruthy();
    expect(screen.getByText("p1.png")).toBeTruthy();
    expect(screen.getByText("p2.png")).toBeTruthy();
    expect(
      screen
        .getByRole("switch", { name: "글자 없이 출력" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "결과물 출력" }));

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        [{ chapterId: CHAPTER_ID, mode: "all" }],
        [],
        DEFAULT_RASTER_OPTIONS,
      ),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes only after a successful export start", async () => {
    const { onClose } = await renderModal(true);

    fireEvent.click(screen.getByRole("button", { name: "결과물 출력" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("preflights and starts a layered PSD export when selected", async () => {
    const { onStart } = await renderModal(false, "psd");

    await waitFor(() =>
      expect(preflightPageImages).toHaveBeenLastCalledWith(
        expect.objectContaining({ outputFormat: "psd" }),
      ),
    );
    expect(screen.getByRole("dialog", { name: "PSD 출력" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "PSD 출력" }));

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        [{ chapterId: CHAPTER_ID, mode: "all" }],
        [],
        { collisionPolicy: "replace" },
      ),
    );
  });

  it("supports current chapter, all, and clear quick selections", async () => {
    const { onStart } = await renderModal(false);
    const exportButton = screen.getByRole("button", { name: "결과물 출력" });

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
        DEFAULT_RASTER_OPTIONS,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "현재 화" }));
    await waitFor(() => expect(exportButton).toHaveProperty("disabled", false));
    fireEvent.click(exportButton);
    await waitFor(() =>
      expect(onStart).toHaveBeenLastCalledWith(
        [{ chapterId: CHAPTER_ID, mode: "all" }],
        [],
        DEFAULT_RASTER_OPTIONS,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    expect(screen.getByRole("button", { name: "결과물 출력" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it.each(["raster", "psd"] as const)(
    "uses a checked Shift anchor for %s output and keeps Ctrl as a single toggle",
    async (kind) => {
      const pages = ["p1", "p2", "p3", "p4"].map(makePage);
      const { onStart } = await renderModal(
        false,
        kind,
        makeChapter(CHAPTER_ID, pages),
      );
      const page = (id: string) =>
        screen.getByRole("checkbox", { name: new RegExp(`${id}\\.png`) });

      fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
      fireEvent.click(page("p1"), { ctrlKey: true });
      expect(page("p1").getAttribute("aria-checked")).toBe("true");
      expect(page("p3").getAttribute("aria-checked")).toBe("false");
      fireEvent.click(page("p4"), { shiftKey: true });
      for (const id of ["p1", "p2", "p3", "p4"]) {
        expect(page(id).getAttribute("aria-checked")).toBe("true");
      }

      const start = screen.getByRole("button", {
        name: kind === "psd" ? "PSD 출력" : "결과물 출력",
      });
      await waitFor(() => expect(start).toHaveProperty("disabled", false));
      fireEvent.click(start);
      await waitFor(() =>
        expect(onStart).toHaveBeenCalledWith(
          [{ chapterId: CHAPTER_ID, mode: "all" }],
          [],
          kind === "psd"
            ? { collisionPolicy: "replace" }
            : DEFAULT_RASTER_OPTIONS,
        ),
      );

      fireEvent.click(page("p4"));
      fireEvent.click(page("p2"), { shiftKey: true });
      expect(page("p1").getAttribute("aria-checked")).toBe("true");
      for (const id of ["p2", "p3", "p4"]) {
        expect(page(id).getAttribute("aria-checked")).toBe("false");
      }
      await waitFor(() => expect(start).toHaveProperty("disabled", false));
      fireEvent.click(start);
      await waitFor(() =>
        expect(onStart).toHaveBeenLastCalledWith(
          [{ chapterId: CHAPTER_ID, mode: "page-set", pageIds: ["p1"] }],
          [],
          kind === "psd"
            ? { collisionPolicy: "replace" }
            : DEFAULT_RASTER_OPTIONS,
        ),
      );
    },
  );

  it("resets the range anchor after a quick action and marks the current page", async () => {
    const originalScroll = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      await renderModal(
        false,
        "raster",
        makeChapter(CHAPTER_ID, [
          makePage("p1"),
          makePage("p2"),
          makePage("p3"),
        ]),
      );
      const page = (id: string) =>
        screen.getByRole("checkbox", { name: new RegExp(`${id}\\.png`) });
      expect(page("p2").closest("label")?.getAttribute("aria-current")).toBe(
        "page",
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      fireEvent.click(page("p1"));
      fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
      fireEvent.click(page("p3"), { shiftKey: true });
      expect(page("p1").getAttribute("aria-checked")).toBe("false");
      expect(page("p2").getAttribute("aria-checked")).toBe("false");
      expect(page("p3").getAttribute("aria-checked")).toBe("true");
    } finally {
      if (originalScroll) {
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalScroll,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("clears an explicitly selected one-page chapter in one checkbox click", async () => {
    await renderModal(
      false,
      "raster",
      makeChapter(CHAPTER_ID, [makePage("p2")]),
    );
    const chapterCheckbox = screen.getByRole("checkbox", { name: "1화" });
    expect((chapterCheckbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(chapterCheckbox);
    expect((chapterCheckbox as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "결과물 출력" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("loads another chapter only when it is expanded", async () => {
    getChapterPageMetadata.mockResolvedValue(
      [makePage("p3"), makePage("p4")].map(
        ({
          id,
          name,
          imagePath,
          width,
          height,
          analysisStatus,
          createdAt,
          updatedAt,
        }) => ({
          id,
          name,
          imagePath,
          width,
          height,
          analysisStatus,
          createdAt,
          updatedAt,
        }),
      ),
    );
    await renderModal(false);

    expect(openChapter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /2화/ }));

    await waitFor(() =>
      expect(getChapterPageMetadata).toHaveBeenCalledWith(
        WORK_ID,
        SECOND_CHAPTER_ID,
      ),
    );
    expect(await screen.findByText("p3.png")).toBeTruthy();
    expect(openChapter).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /2화/ }));
    fireEvent.click(screen.getByRole("button", { name: /2화/ }));
    expect(getChapterPageMetadata).toHaveBeenCalledOnce();
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

    fireEvent.click(screen.getByRole("switch", { name: "글자 없이 출력" }));

    await waitFor(() =>
      expect(preflightPageImages).toHaveBeenLastCalledWith(
        expect.objectContaining({ omitText: true }),
      ),
    );
    const exportButton = screen.getByRole("button", { name: "결과물 출력" });
    await waitFor(() => expect(exportButton).toHaveProperty("disabled", false));
    fireEvent.click(exportButton);

    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(
        [{ chapterId: CHAPTER_ID, mode: "all" }],
        [],
        { ...DEFAULT_RASTER_OPTIONS, omitText: true },
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

    fireEvent.click(screen.getByRole("switch", { name: "글자 없이 출력" }));

    expect(
      await screen.findByText(
        "인페인팅 결과가 없어 글자 없는 출력을 만들 수 없습니다.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "결과물 출력" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("remembered export choices", () => {
  async function renderWithPreferences(
    savedPreferences: unknown,
    onPersistPreferences = vi.fn<
      (value: ExportPreferences) => Promise<boolean>
    >(async () => true),
  ) {
    const onStart = vi.fn().mockResolvedValue(false);
    const view = render(
      <ExportOptionsModal
        chapter={makeChapter()}
        currentPageId="p2"
        jobActive={false}
        library={makeLibrary()}
        savedPreferences={savedPreferences}
        onPersistPreferences={onPersistPreferences}
        onStart={onStart}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("출력 가능");
    return { onPersistPreferences, onStart, view };
  }

  it("restores the safe choices but always reopens without overwrite or textless output", async () => {
    const { onPersistPreferences, onStart } = await renderWithPreferences({
      outputFormat: "webp",
      jpegQuality: 80,
      webpQuality: 70,
      preserveSourceNames: false,
      destinationMode: "fixed",
      collisionPolicy: "replace",
      omitText: true,
    });

    expect(
      screen.getByRole("combobox", { name: "파일 형식" }).textContent,
    ).toBe("WebP");
    expect(
      screen.getByRole("combobox", { name: "저장 위치 방식" }).textContent,
    ).toBe("선택한 폴더에 바로 저장");
    expect(
      screen.getByRole("combobox", { name: "같은 이름의 파일" }).textContent,
    ).toBe("출력 취소");
    expect(
      screen
        .getByRole("switch", { name: "글자 없이 출력" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "결과물 출력" }));
    await waitFor(() =>
      expect(onStart).toHaveBeenCalledWith(expect.any(Array), [], {
        outputFormat: "webp",
        jpegQuality: 80,
        webpQuality: 70,
        preserveSourceNames: false,
        destinationMode: "fixed",
        collisionPolicy: "cancel",
      }),
    );
    expect(onPersistPreferences).not.toHaveBeenCalled();
  });

  it("saves one consolidated snapshot without per-run choices", async () => {
    const { onPersistPreferences } = await renderWithPreferences(undefined);

    chooseCustomSelectOption("파일 형식", "JPEG");
    await waitFor(() => expect(onPersistPreferences).toHaveBeenCalledTimes(1));
    expect(onPersistPreferences).toHaveBeenLastCalledWith({
      outputFormat: "jpeg",
      jpegQuality: 95,
      webpQuality: 90,
      preserveSourceNames: true,
      destinationMode: "timestamped",
    });

    chooseCustomSelectOption("같은 이름의 파일", "교체");
    fireEvent.click(screen.getByRole("switch", { name: "글자 없이 출력" }));
    await act(async () => undefined);
    expect(onPersistPreferences).toHaveBeenCalledTimes(1);
  });

  it("sends every committed choice in order and ignores an older failure", async () => {
    const pending: Array<(saved: boolean) => void> = [];
    const persist = vi.fn<(value: ExportPreferences) => Promise<boolean>>(
      () => new Promise<boolean>((resolve) => pending.push(resolve)),
    );
    await renderWithPreferences(undefined, persist);

    chooseCustomSelectOption("파일 형식", "PNG");
    chooseCustomSelectOption("파일 형식", "JPEG");
    chooseCustomSelectOption("파일 형식", "WebP");
    expect(persist.mock.calls.map(([value]) => value.outputFormat)).toEqual([
      "png",
      "jpeg",
      "webp",
    ]);

    await act(async () => pending[2]?.(true));
    await act(async () => pending[0]?.(false));
    expect(screen.queryByText(/출력 설정을 저장하지 못했습니다/)).toBeNull();
  });

  it("tells the user when a choice could not be remembered", async () => {
    await renderWithPreferences(
      undefined,
      vi.fn(async () => false),
    );
    chooseCustomSelectOption("저장 위치 방식", "선택한 폴더에 바로 저장");
    expect(
      await screen.findByText(/출력 설정을 저장하지 못했습니다/),
    ).toBeTruthy();
  });
});
