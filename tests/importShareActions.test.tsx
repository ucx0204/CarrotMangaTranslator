/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useImportShareActions } from "../src/renderer/src/hooks/useImportShareActions";
import type { ImportPreviewSession } from "../src/shared/importTypes";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

const TS = "2026-07-29T00:00:00.000Z";

afterEach(() => {
  cleanup();
  window.mangaApi = createTestMangaGatewayStub();
  vi.clearAllMocks();
});

describe("useImportShareActions", () => {
  it("opens the normal translation modal with the whole work selected after a batch import", async () => {
    const openedChapter = makeChapter();
    const createImport = vi.fn(async () => ({
      workId: openedChapter.workId,
      chapterIds: [openedChapter.id, "chapter-2"],
      openedChapter,
    }));
    window.mangaApi = createTestMangaGatewayStub({ createImport });
    const openTranslateOptions = vi.fn();
    const applyChapter = vi.fn();
    const refreshLibrary = vi.fn(async () => undefined);
    const resetWorkspaceHistory = vi.fn();
    const setImportPreview = vi.fn();
    const { result } = renderHook(() =>
      useImportShareActions({
        applyChapter,
        askConfirm: vi.fn(async () => true),
        dirty: false,
        importPreview: makePreview("batch"),
        openTranslateOptions,
        pushStatus: vi.fn(),
        refreshLibrary,
        resetWorkspaceHistory,
        saveNow: vi.fn(async () => undefined),
        setImportBusy: vi.fn(),
        setImportPreview,
        setShareExportBusy: vi.fn(),
        setShareExportOpen: vi.fn(),
        setShareImportBusy: vi.fn(),
        setShareImportPreview: vi.fn(),
        setTranslationSourceOpen: vi.fn(),
        shareImportPreview: null,
      }),
    );

    await act(async () => {
      await result.current.submitImport({
        target: { mode: "new", title: "새 작품" },
        selections: [
          { draftId: "draft-1", title: "1화", enabled: true },
          { draftId: "draft-2", title: "2화", enabled: true },
        ],
      });
    });

    expect(createImport).toHaveBeenCalledWith({
      previewId: "preview-1",
      target: { mode: "new", title: "새 작품" },
      selections: [
        { draftId: "draft-1", title: "1화", enabled: true },
        { draftId: "draft-2", title: "2화", enabled: true },
      ],
    });
    expect(refreshLibrary).toHaveBeenCalledOnce();
    expect(resetWorkspaceHistory).toHaveBeenCalledOnce();
    expect(applyChapter).toHaveBeenCalledWith(
      openedChapter,
      expect.any(String),
    );
    expect(setImportPreview).toHaveBeenCalledWith(null);
    expect(openTranslateOptions).toHaveBeenCalledWith("work-all");
  });

  it("does not open translation options after an ordinary single import", async () => {
    const openedChapter = makeChapter();
    window.mangaApi = createTestMangaGatewayStub({
      createImport: vi.fn(async () => ({
        workId: openedChapter.workId,
        chapterIds: [openedChapter.id],
        openedChapter,
      })),
    });
    const openTranslateOptions = vi.fn();
    const { result } = renderHook(() =>
      useImportShareActions({
        applyChapter: vi.fn(),
        askConfirm: vi.fn(async () => true),
        dirty: false,
        importPreview: makePreview("single"),
        openTranslateOptions,
        pushStatus: vi.fn(),
        refreshLibrary: vi.fn(async () => undefined),
        resetWorkspaceHistory: vi.fn(),
        saveNow: vi.fn(async () => undefined),
        setImportBusy: vi.fn(),
        setImportPreview: vi.fn(),
        setShareExportBusy: vi.fn(),
        setShareExportOpen: vi.fn(),
        setShareImportBusy: vi.fn(),
        setShareImportPreview: vi.fn(),
        setTranslationSourceOpen: vi.fn(),
        shareImportPreview: null,
      }),
    );

    await act(async () => {
      await result.current.submitImport({
        target: { mode: "new", title: "새 작품" },
        selections: [{ draftId: "draft-1", title: "1화", enabled: true }],
      });
    });

    expect(openTranslateOptions).not.toHaveBeenCalled();
  });
});

function makePreview(mode: "single" | "batch"): ImportPreviewSession {
  return {
    previewId: "preview-1",
    mode,
    sourceKind: "images",
    suggestedWorkTitle: "새 작품",
    chapters: [
      {
        draftId: "draft-1",
        title: "1화",
        sourceKind: "images",
        pages: [
          {
            name: "1.png",
            sourcePath: "C:/source/1.png",
            sourceKind: "file",
          },
        ],
      },
      {
        draftId: "draft-2",
        title: "2화",
        sourceKind: "images",
        pages: [
          {
            name: "2.png",
            sourcePath: "C:/source/2.png",
            sourceKind: "file",
          },
        ],
      },
    ],
  };
}

function makeChapter(): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [],
    pages: [],
    createdAt: TS,
    updatedAt: TS,
  };
}
