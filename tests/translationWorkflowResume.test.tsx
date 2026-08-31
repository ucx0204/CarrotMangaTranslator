// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { UseTranslationActionsOptions } from "../src/renderer/src/hooks/translationActionTypes";
import { useTranslationActions } from "../src/renderer/src/hooks/useTranslationActions";
import type { NotificationPort } from "../src/renderer/src/lib/notificationPort";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";

const startAnalysis = vi.fn();
const startInpainting = vi.fn();
const openChapter = vi.fn();
const notificationMocks: NotificationPort = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
};
const TS = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  window.mangaApi = createTestMangaGatewayStub({
    openChapter,
    startAnalysis,
    startInpainting,
  });
});

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("translation workflow checkpoint and receipt resume", () => {
  it("skips a fully completed pending erase-only workflow", async () => {
    const options = makeOptions();
    openChapter.mockResolvedValue({
      ...makeChapter(),
      pages: [
        {
          ...makePage(),
          analysisStatus: "completed",
          translationCompletion: {
            workflow: "erase-original",
            status: "completed",
          },
        },
      ],
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [{ chapterId: "chapter-1", mode: "pending" }],
        workflowMode: "cumulative",
        blockMode: "auto",
        eraseOriginalWorkflow: true,
        bubbleLayoutWorkflow: false,
      });
    });

    expect(startAnalysis).not.toHaveBeenCalled();
    expect(startInpainting).not.toHaveBeenCalled();
  });

  it("restarts a matching postprocess receipt when the page intent is explicit", async () => {
    const options = makeOptions();
    openChapter.mockResolvedValue({
      ...makeChapter(),
      pages: [
        {
          ...makePage(),
          analysisStatus: "completed",
          translationCompletion: {
            workflow: "bubble-layout",
            status: "pending",
          },
        },
      ],
    });
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 1,
      blocksErased: 1,
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [
          {
            chapterId: "chapter-1",
            mode: "page-set",
            pageIds: ["page-1"],
            restartPageIds: ["page-1"],
          },
        ],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        runMode: "page-set",
        pageIds: ["page-1"],
        restartPageIds: ["page-1"],
      }),
    );
  });

  it("keeps completed resumed pages out of analysis while postprocessing the full explicit selection", async () => {
    const options = makeOptions();
    openChapter.mockResolvedValue({
      ...makeChapter(),
      pages: [
        {
          ...makePage(),
          id: "page-1",
          analysisStatus: "completed",
          translationCompletion: {
            workflow: "bubble-layout",
            status: "pending",
          },
        },
        {
          ...makePage(),
          id: "page-2",
          analysisStatus: "completed",
          translationCompletion: {
            workflow: "bubble-layout",
            status: "pending",
          },
        },
        {
          ...makePage(),
          id: "page-3",
          analysisStatus: "idle",
        },
      ],
    });
    startAnalysis.mockResolvedValue({ status: "completed" });
    startInpainting.mockResolvedValue({
      status: "completed",
      chapters: [makeChapter()],
      pagesChanged: 2,
      blocksErased: 2,
    });
    const { result } = renderHook(() =>
      useTranslationActions(options, notificationMocks),
    );

    await act(async () => {
      await result.current.runTranslationFlow({
        selection: [
          {
            chapterId: "chapter-1",
            mode: "page-set",
            pageIds: ["page-1", "page-2"],
            restartPageIds: ["page-2"],
          },
        ],
        workflowMode: "cumulative",
        blockMode: "auto",
        bubbleLayoutWorkflow: true,
      });
    });

    expect(startAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({
        runMode: "page-set",
        pageIds: ["page-2"],
        restartPageIds: ["page-2"],
      }),
    );
    expect(startInpainting).toHaveBeenCalledWith(
      expect.objectContaining({
        selections: [
          {
            chapterId: "chapter-1",
            mode: "page-set",
            pageIds: ["page-1", "page-2"],
          },
        ],
      }),
    );
  });
});

function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "C:/page.png",
    dataUrl: "",
    width: 100,
    height: 150,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeChapter(): ChapterSnapshot {
  const page = makePage();
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [page],
    createdAt: TS,
    updatedAt: TS,
  };
}

function makeOptions(): UseTranslationActionsOptions {
  const chapter = makeChapter();
  return {
    clearPageImageCache: vi.fn(),
    clearRetouchHistory: vi.fn(),
    currentChapter: chapter,
    currentChapterRef: { current: chapter },
    jobActive: false,
    library: { workOrder: [], works: [] },
    mergeLiveChapter: vi.fn(),
    pushStatus: vi.fn(),
    refreshLibrary: vi.fn().mockResolvedValue(undefined),
    recordImageEdit: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    selectedPage: null,
    setCurrentChapter: vi.fn(),
    setFlowActive: vi.fn(),
    setShowBlockChrome: vi.fn(),
    setJobState: vi.fn(),
    setSelectedBlockId: vi.fn(),
    syncSavedPageVersion: vi.fn(),
  };
}
