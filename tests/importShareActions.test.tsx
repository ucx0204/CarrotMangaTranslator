/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useImportShareModalController } from "../src/renderer/src/hooks/useImportShareModalController";
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
  it("opens a fresh import modal for a preview and clears its draft when discarded", () => {
    const payload = {
      target: { mode: "new" as const, title: "복원할 작품" },
      selections: [{ draftId: "draft-1", title: "복원할 제목", enabled: true }],
    };
    const { result } = renderHook(() => useImportShareModalController());

    expect(result.current.importModalOpen).toBe(false);
    act(() => {
      result.current.setImportDraft(payload);
      result.current.setImportFeedback({
        variant: "info",
        message: "이전 안내",
      });
      result.current.setImportPreview(makePreview("single"));
    });
    expect(result.current.importModalOpen).toBe(true);
    expect(result.current.importDraft).toBeNull();
    expect(result.current.importFeedback).toBeNull();

    act(() => {
      result.current.setImportDraft(payload);
      result.current.setImportPreview(null);
    });
    expect(result.current.importModalOpen).toBe(false);
    expect(result.current.importDraft).toBeNull();
    expect(result.current.importFeedback).toBeNull();
  });

  it("closes the import modal immediately and keeps the draft while the library write runs", async () => {
    let finishImport!: (value: ReturnType<typeof makeImportResult>) => void;
    const createImport = vi.fn(
      () =>
        new Promise<ReturnType<typeof makeImportResult>>((resolve) => {
          finishImport = resolve;
        }),
    );
    window.mangaApi = createTestMangaGatewayStub({ createImport });
    const setImportModalOpen = vi.fn();
    const setImportDraft = vi.fn();
    const setImportFeedback = vi.fn();
    const setImportBusy = vi.fn();
    const payload = {
      target: { mode: "new" as const, title: "보존할 작품명" },
      selections: [
        { draftId: "draft-1", title: "보존할 화 제목", enabled: true },
      ],
    };
    const { result } = renderHook(() =>
      useImportShareActions({
        ...makeBackgroundOptions(),
        applyChapter: vi.fn(),
        askConfirm: vi.fn(async () => true),
        dirty: false,
        importPreview: makePreview("single"),
        openTranslateOptions: vi.fn(),
        pushStatus: vi.fn(),
        refreshLibrary: vi.fn(async () => undefined),
        resetWorkspaceHistory: vi.fn(),
        saveNow: vi.fn(async () => undefined),
        setImportBusy,
        setImportDraft,
        setImportFeedback,
        setImportModalOpen,
        setImportPreview: vi.fn(),
        setShareExportBusy: vi.fn(),
        setShareExportOpen: vi.fn(),
        setShareImportBusy: vi.fn(),
        setShareImportPreview: vi.fn(),
        setTranslationSourceOpen: vi.fn(),
        setWebImportOpen: vi.fn(),
        shareImportPreview: null,
      }),
    );

    let submission!: Promise<void>;
    await act(async () => {
      submission = result.current.submitImport(payload);
      await Promise.resolve();
    });

    expect(setImportDraft).toHaveBeenCalledWith(payload);
    expect(setImportFeedback).toHaveBeenCalledWith(null);
    expect(setImportModalOpen).toHaveBeenCalledWith(false);
    expect(setImportBusy).toHaveBeenCalledWith(true);
    expect(createImport).toHaveBeenCalledOnce();

    await act(async () => {
      finishImport(makeImportResult());
      await submission;
    });
    expect(setImportBusy).toHaveBeenLastCalledWith(false);
  });

  it("reopens a cancelled import with its exact draft and an informational notice", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      createImport: vi.fn(async () => {
        throw new DOMException("cancel import", "AbortError");
      }),
    });
    const setImportModalOpen = vi.fn();
    const setImportDraft = vi.fn();
    const setImportFeedback = vi.fn();
    const payload = {
      target: { mode: "existing" as const, workId: "work-7" },
      selections: [
        { draftId: "draft-1", title: "수정한 제목", enabled: true },
        { draftId: "draft-2", title: "제외한 화", enabled: false },
      ],
      linkedWorkspace: {
        enabled: false,
        outputFormat: "webp" as const,
        jpegQuality: 91,
        webpQuality: 82,
      },
    };
    const { result } = renderHook(() =>
      useImportShareActions({
        ...makeBackgroundOptions(),
        applyChapter: vi.fn(),
        askConfirm: vi.fn(async () => true),
        dirty: false,
        importPreview: makePreview("batch"),
        openTranslateOptions: vi.fn(),
        pushStatus: vi.fn(),
        refreshLibrary: vi.fn(async () => undefined),
        resetWorkspaceHistory: vi.fn(),
        saveNow: vi.fn(async () => undefined),
        setImportBusy: vi.fn(),
        setImportDraft,
        setImportFeedback,
        setImportModalOpen,
        setImportPreview: vi.fn(),
        setShareExportBusy: vi.fn(),
        setShareExportOpen: vi.fn(),
        setShareImportBusy: vi.fn(),
        setShareImportPreview: vi.fn(),
        setTranslationSourceOpen: vi.fn(),
        setWebImportOpen: vi.fn(),
        shareImportPreview: null,
      }),
    );

    await act(async () => result.current.submitImport(payload));

    expect(setImportDraft).toHaveBeenCalledWith(payload);
    expect(setImportModalOpen.mock.calls).toEqual([[false], [true]]);
    expect(setImportFeedback).toHaveBeenLastCalledWith(
      expect.objectContaining({ variant: "info" }),
    );
  });

  it("never reopens a consumed preview after the library transaction commits", async () => {
    window.mangaApi = createTestMangaGatewayStub({
      createImport: vi.fn(async () => makeImportResult()),
    });
    const applyChapter = vi.fn();
    const pushStatus = vi.fn();
    const setImportBusy = vi.fn();
    const setImportModalOpen = vi.fn();
    const setImportPreview = vi.fn();
    const { result } = renderHook(() =>
      useImportShareActions({
        ...makeBackgroundOptions(),
        applyChapter,
        askConfirm: vi.fn(async () => true),
        dirty: false,
        importPreview: makePreview("single"),
        openTranslateOptions: vi.fn(),
        pushStatus,
        refreshLibrary: vi.fn(async () => {
          throw new Error("refresh failed after commit");
        }),
        resetWorkspaceHistory: vi.fn(),
        saveNow: vi.fn(async () => undefined),
        setImportBusy,
        setImportModalOpen,
        setImportPreview,
        setShareExportBusy: vi.fn(),
        setShareExportOpen: vi.fn(),
        setShareImportBusy: vi.fn(),
        setShareImportPreview: vi.fn(),
        setTranslationSourceOpen: vi.fn(),
        setWebImportOpen: vi.fn(),
        shareImportPreview: null,
      }),
    );

    await act(async () =>
      result.current.submitImport({
        target: { mode: "new", title: "새 작품" },
        selections: [{ draftId: "draft-1", title: "1화", enabled: true }],
      }),
    );

    expect(setImportPreview).toHaveBeenCalledWith(null);
    expect(setImportModalOpen.mock.calls).toEqual([[false]]);
    expect(applyChapter).toHaveBeenCalledOnce();
    expect(pushStatus).toHaveBeenCalledWith(
      "보관함 목록을 새로고침하지 못했습니다.",
    );
    expect(setImportBusy).toHaveBeenLastCalledWith(false);
  });

  it("saves a dirty page before commit and reports linked-workspace warnings", async () => {
    const createImport = vi.fn(async () => ({
      ...makeImportResult(),
      linkedWorkspaceWarning: "연결 폴더의 일부 파일을 갱신하지 못했습니다.",
    }));
    window.mangaApi = createTestMangaGatewayStub({ createImport });
    const saveNow = vi.fn(async () => undefined);
    const pushStatus = vi.fn();
    const { result } = renderHook(() =>
      useImportShareActions({
        ...makeBackgroundOptions(),
        applyChapter: vi.fn(),
        askConfirm: vi.fn(async () => true),
        dirty: true,
        importPreview: makePreview("single"),
        openTranslateOptions: vi.fn(),
        pushStatus,
        refreshLibrary: vi.fn(async () => undefined),
        resetWorkspaceHistory: vi.fn(),
        saveNow,
        setImportBusy: vi.fn(),
        setImportPreview: vi.fn(),
        setShareExportBusy: vi.fn(),
        setShareExportOpen: vi.fn(),
        setShareImportBusy: vi.fn(),
        setShareImportPreview: vi.fn(),
        setTranslationSourceOpen: vi.fn(),
        setWebImportOpen: vi.fn(),
        shareImportPreview: null,
      }),
    );
    const linkedWorkspace = {
      enabled: true,
      outputFormat: "png" as const,
      jpegQuality: 90,
      webpQuality: 80,
    };

    await act(async () =>
      result.current.submitImport({
        target: { mode: "new", title: "새 작품" },
        selections: [{ draftId: "draft-1", title: "1화", enabled: true }],
        linkedWorkspace,
      }),
    );

    expect(saveNow).toHaveBeenCalled();
    expect(saveNow.mock.invocationCallOrder[0]).toBeLessThan(
      createImport.mock.invocationCallOrder[0],
    );
    expect(createImport).toHaveBeenCalledWith(
      expect.objectContaining({ linkedWorkspace }),
    );
    expect(pushStatus).toHaveBeenCalledWith(
      "연결 폴더의 일부 파일을 갱신하지 못했습니다.",
    );
  });

  it("opens the web import modal instead of requesting a file preview", async () => {
    const setTranslationSourceOpen = vi.fn();
    const setWebImportOpen = vi.fn();
    const { result } = renderHook(() =>
      useImportShareActions({
        ...makeBackgroundOptions(),
        applyChapter: vi.fn(),
        askConfirm: vi.fn(async () => true),
        dirty: false,
        importPreview: null,
        openTranslateOptions: vi.fn(),
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
        setTranslationSourceOpen,
        setWebImportOpen,
        shareImportPreview: null,
      }),
    );

    await act(async () => result.current.selectTranslateSource("web"));

    expect(setTranslationSourceOpen).toHaveBeenCalledWith(false);
    expect(setWebImportOpen).toHaveBeenCalledWith(true);
  });

  it("requests and opens a PDF import preview", async () => {
    const preview = makePreview("single");
    const previewPdfImport = vi.fn(async () => preview);
    window.mangaApi = createTestMangaGatewayStub({ previewPdfImport });
    const setImportPreview = vi.fn();
    const setTranslationSourceOpen = vi.fn();
    const { result } = renderHook(() =>
      useImportShareActions({
        ...makeBackgroundOptions(),
        applyChapter: vi.fn(),
        askConfirm: vi.fn(async () => true),
        dirty: false,
        importPreview: null,
        openTranslateOptions: vi.fn(),
        pushStatus: vi.fn(),
        refreshLibrary: vi.fn(async () => undefined),
        resetWorkspaceHistory: vi.fn(),
        saveNow: vi.fn(async () => undefined),
        setImportBusy: vi.fn(),
        setImportPreview,
        setShareExportBusy: vi.fn(),
        setShareExportOpen: vi.fn(),
        setShareImportBusy: vi.fn(),
        setShareImportPreview: vi.fn(),
        setTranslationSourceOpen,
        setWebImportOpen: vi.fn(),
        shareImportPreview: null,
      }),
    );

    await act(async () => result.current.selectTranslateSource("pdf"));

    expect(setTranslationSourceOpen).toHaveBeenCalledWith(false);
    expect(previewPdfImport).toHaveBeenCalledOnce();
    expect(setImportPreview).toHaveBeenCalledWith(preview);
  });

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
        ...makeBackgroundOptions(),
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
        setWebImportOpen: vi.fn(),
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
        ...makeBackgroundOptions(),
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
        setWebImportOpen: vi.fn(),
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

  it("closes share export immediately and restores the exact draft when saving is cancelled", async () => {
    const exporting = deferred<null>();
    window.mangaApi = createTestMangaGatewayStub({
      exportWorkShare: vi.fn(() => exporting.promise),
    });
    const setShareExportBusy = vi.fn();
    const setShareExportDraft = vi.fn();
    const setShareExportOpen = vi.fn();
    const request = { workId: "work-1", chapterIds: ["chapter-1"] };
    const { result } = renderHook(() =>
      useImportShareActions({
        ...makeBackgroundOptions(),
        applyChapter: vi.fn(),
        askConfirm: vi.fn(async () => true),
        dirty: false,
        importPreview: null,
        openTranslateOptions: vi.fn(),
        pushStatus: vi.fn(),
        refreshLibrary: vi.fn(async () => undefined),
        resetWorkspaceHistory: vi.fn(),
        saveNow: vi.fn(async () => undefined),
        setImportBusy: vi.fn(),
        setImportPreview: vi.fn(),
        setShareExportBusy,
        setShareExportDraft,
        setShareExportOpen,
        setShareImportBusy: vi.fn(),
        setShareImportDraft: vi.fn(),
        setShareImportPreview: vi.fn(),
        setTranslationSourceOpen: vi.fn(),
        setWebImportOpen: vi.fn(),
        shareImportPreview: null,
      }),
    );

    let submission!: Promise<void>;
    await act(async () => {
      submission = result.current.submitShareExport(request);
      await Promise.resolve();
    });
    expect(setShareExportDraft).toHaveBeenCalledWith(request);
    expect(setShareExportOpen).toHaveBeenCalledWith(false);
    expect(setShareExportBusy).toHaveBeenCalledWith(true);

    await act(async () => {
      exporting.resolve(null);
      await submission;
    });
    expect(setShareExportOpen.mock.calls).toEqual([[false], [true]]);
    expect(setShareExportBusy).toHaveBeenLastCalledWith(false);
  });

  it("closes share import while applying and never restores a consumed preview", async () => {
    const importing = deferred<ReturnType<typeof makeImportResult>>();
    window.mangaApi = createTestMangaGatewayStub({
      importWorkShare: vi.fn(() => importing.promise),
    });
    const preview = makeSharePreview();
    const payload = {
      target: { mode: "new" as const, title: "공유 작품" },
      entries: [
        {
          source: "package" as const,
          packageChapterId: "package-1",
          title: "공유 1화",
        },
      ],
      remainingPackageChapters: [],
      deletedExistingChapters: [],
    };
    const setShareImportBusy = vi.fn();
    const setShareImportDraft = vi.fn();
    const setShareImportPreview = vi.fn();
    const applyChapter = vi.fn();
    const { result } = renderHook(() =>
      useImportShareActions({
        ...makeBackgroundOptions(),
        applyChapter,
        askConfirm: vi.fn(async () => true),
        dirty: false,
        importPreview: null,
        openTranslateOptions: vi.fn(),
        pushStatus: vi.fn(),
        refreshLibrary: vi.fn(async () => undefined),
        resetWorkspaceHistory: vi.fn(),
        saveNow: vi.fn(async () => undefined),
        setImportBusy: vi.fn(),
        setImportPreview: vi.fn(),
        setShareExportBusy: vi.fn(),
        setShareExportDraft: vi.fn(),
        setShareExportOpen: vi.fn(),
        setShareImportBusy,
        setShareImportDraft,
        setShareImportPreview,
        setTranslationSourceOpen: vi.fn(),
        setWebImportOpen: vi.fn(),
        shareImportPreview: preview,
      }),
    );

    let submission!: Promise<void>;
    await act(async () => {
      submission = result.current.submitShareImport(payload);
      await Promise.resolve();
    });
    expect(setShareImportDraft).toHaveBeenCalledWith(payload);
    expect(setShareImportPreview).toHaveBeenCalledWith(null);
    expect(setShareImportBusy).toHaveBeenCalledWith(true);

    await act(async () => {
      importing.resolve(makeImportResult());
      await submission;
    });
    expect(setShareImportDraft).toHaveBeenLastCalledWith(null);
    expect(setShareImportPreview.mock.calls).toEqual([[null]]);
    expect(applyChapter).toHaveBeenCalledOnce();
    expect(setShareImportBusy).toHaveBeenLastCalledWith(false);
  });
});

function makeBackgroundOptions() {
  return {
    getNavigationKey: () => "chapter-1:page-1",
    setShareExportDraft: vi.fn(),
    setShareImportDraft: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function makeSharePreview() {
  return {
    previewId: "share-preview-1",
    workTitle: "공유 작품",
    chapters: [
      { packageChapterId: "package-1", title: "공유 1화", pageCount: 1 },
    ],
  };
}

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

function makeImportResult() {
  const openedChapter = makeChapter();
  return {
    workId: openedChapter.workId,
    chapterIds: [openedChapter.id],
    openedChapter,
  };
}
