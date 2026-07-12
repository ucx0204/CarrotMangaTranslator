// @vitest-environment jsdom

import React, { useCallback, useEffect, useRef, useState } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import { useReorderPagesAction } from "../src/renderer/src/hooks/useReorderPagesAction";

const { reorderPagesMock } = vi.hoisted(() => ({
  reorderPagesMock: vi.fn(),
}));

vi.mock("../src/renderer/src/hooks/libraryGateway", () => ({
  libraryGateway: {
    reorderPages: reorderPagesMock,
  },
}));

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
};

type HarnessApi = {
  currentChapterRef: React.MutableRefObject<ChapterSnapshot | null>;
  getChapter: () => ChapterSnapshot | null;
  getStatusLines: () => string[];
  replaceChapter: (chapter: ChapterSnapshot) => void;
  reorder: (sourcePageId: string, targetPageId: string) => void;
};

beforeEach(() => {
  reorderPagesMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("page reorder action", () => {
  it("applies the optimistic page order before waiting for dirty page saves", async () => {
    const saveGate = createDeferred<void>();
    const saveNow = vi.fn(() => saveGate.promise);
    const expectedOrder = ["page-2", "page-1", "page-3"];
    reorderPagesMock.mockResolvedValue(makeChapter(expectedOrder));

    const api = renderHarness({ dirty: true, saveNow });

    act(() => {
      api.current.reorder("page-2", "page-1");
    });

    expect(api.current.getChapter()?.pageOrder).toEqual(expectedOrder);
    expect(api.current.currentChapterRef.current?.pageOrder).toEqual(
      expectedOrder,
    );
    expect(saveNow).toHaveBeenCalledOnce();
    expect(reorderPagesMock).not.toHaveBeenCalled();

    await act(async () => {
      saveGate.resolve(undefined);
      await saveGate.promise;
    });

    await waitFor(() => {
      expect(reorderPagesMock).toHaveBeenCalledWith("chapter-1", expectedOrder);
    });
    expect(api.current.getStatusLines()).toEqual([]);
  });

  it("rolls back the optimistic order when dirty page persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const saveNow = vi.fn().mockRejectedValue(new Error("disk full"));
    const refreshLibrary = vi.fn(async () => undefined);
    const api = renderHarness({ dirty: true, refreshLibrary, saveNow });

    act(() => {
      api.current.reorder("page-2", "page-1");
    });

    expect(api.current.getChapter()?.pageOrder).toEqual([
      "page-2",
      "page-1",
      "page-3",
    ]);
    await waitFor(() => {
      expect(api.current.getStatusLines()).toEqual([
        "현재 수정사항을 저장하지 못해 페이지 순서를 저장하지 않았습니다.",
        "페이지 순서를 이전 순서로 되돌렸습니다.",
      ]);
    });

    expect(api.current.getChapter()?.pageOrder).toEqual([
      "page-1",
      "page-2",
      "page-3",
    ]);
    expect(api.current.currentChapterRef.current?.pageOrder).toEqual([
      "page-1",
      "page-2",
      "page-3",
    ]);
    expect(reorderPagesMock).not.toHaveBeenCalled();
    expect(refreshLibrary).not.toHaveBeenCalled();
  });

  it("rolls back after the page-order request fails and does not refresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refreshLibrary = vi.fn(async () => undefined);
    reorderPagesMock.mockRejectedValue(new Error("write failed"));
    const api = renderHarness({ dirty: false, refreshLibrary });

    act(() => {
      api.current.reorder("page-2", "page-1");
    });

    await waitFor(() => {
      expect(api.current.getStatusLines()).toEqual([
        "페이지 순서를 저장하지 못했습니다. 이전 순서로 되돌렸습니다.",
      ]);
    });
    expect(api.current.getChapter()?.pageOrder).toEqual([
      "page-1",
      "page-2",
      "page-3",
    ]);
    expect(refreshLibrary).not.toHaveBeenCalled();
  });

  it("does not let an older failed reorder overwrite newer chapter state", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reorderGate = createDeferred<ChapterSnapshot>();
    reorderPagesMock.mockReturnValue(reorderGate.promise);
    const api = renderHarness({ dirty: false });

    act(() => {
      api.current.reorder("page-2", "page-1");
    });
    const newerChapter = makeChapter(["page-3", "page-2", "page-1"]);
    act(() => {
      api.current.replaceChapter(newerChapter);
    });

    await act(async () => {
      reorderGate.reject(new Error("late failure"));
      await expect(reorderGate.promise).rejects.toThrow("late failure");
    });

    await waitFor(() => {
      expect(api.current.getStatusLines()).toHaveLength(1);
    });
    expect(api.current.getChapter()?.pageOrder).toEqual(newerChapter.pageOrder);
    expect(api.current.currentChapterRef.current?.pageOrder).toEqual(
      newerChapter.pageOrder,
    );
  });

  it("keeps the persisted order when the follow-up library refresh fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const persistedChapter = {
      ...makeChapter(["page-2", "page-1", "page-3"]),
      updatedAt: "2026-01-01T00:00:10.000Z",
    };
    const refreshLibrary = vi.fn().mockRejectedValue(new Error("offline"));
    reorderPagesMock.mockResolvedValue(persistedChapter);
    const api = renderHarness({ dirty: false, refreshLibrary });

    act(() => {
      api.current.reorder("page-2", "page-1");
    });

    await waitFor(() => {
      expect(api.current.getStatusLines()).toEqual([
        "보관함 목록을 불러오지 못했습니다.",
      ]);
    });
    expect(api.current.getChapter()).toEqual(persistedChapter);
    expect(reorderPagesMock).toHaveBeenCalledOnce();
    expect(refreshLibrary).toHaveBeenCalledOnce();
  });

  it("does nothing when either page id cannot produce a new order", async () => {
    const saveNow = vi.fn(async () => undefined);
    const refreshLibrary = vi.fn(async () => undefined);
    const api = renderHarness({ dirty: true, refreshLibrary, saveNow });

    act(() => {
      api.current.reorder("missing-page", "page-1");
      api.current.reorder("page-1", "page-1");
    });
    await Promise.resolve();

    expect(api.current.getChapter()?.pageOrder).toEqual([
      "page-1",
      "page-2",
      "page-3",
    ]);
    expect(saveNow).not.toHaveBeenCalled();
    expect(reorderPagesMock).not.toHaveBeenCalled();
    expect(refreshLibrary).not.toHaveBeenCalled();
    expect(api.current.getStatusLines()).toEqual([]);
  });
});

function renderHarness({
  dirty,
  refreshLibrary = async () => undefined,
  saveNow = async () => undefined,
}: {
  dirty: boolean;
  refreshLibrary?: () => Promise<void>;
  saveNow?: () => Promise<void>;
}): React.MutableRefObject<HarnessApi> {
  const api = React.createRef<HarnessApi>();

  render(
    React.createElement(ReorderPagesHarness, {
      dirty,
      onReady: (nextApi: HarnessApi) => {
        api.current = nextApi;
      },
      refreshLibrary,
      saveNow,
    }),
  );

  if (!api.current) {
    throw new Error("Reorder pages harness did not initialize.");
  }
  return api as React.MutableRefObject<HarnessApi>;
}

function ReorderPagesHarness({
  dirty,
  onReady,
  refreshLibrary,
  saveNow,
}: {
  dirty: boolean;
  onReady: (api: HarnessApi) => void;
  refreshLibrary: () => Promise<void>;
  saveNow: () => Promise<void>;
}): React.JSX.Element | null {
  const [chapter, setChapter] = useState<ChapterSnapshot | null>(() =>
    makeChapter(["page-1", "page-2", "page-3"]),
  );
  const currentChapterRef = useRef<ChapterSnapshot | null>(chapter);
  const statusLinesRef = useRef<string[]>([]);
  const applyChapter = useCallback(
    (nextChapter: ChapterSnapshot | undefined) => {
      if (nextChapter) {
        currentChapterRef.current = nextChapter;
        setChapter(nextChapter);
      }
    },
    [],
  );
  const pushStatus = useCallback((line: string) => {
    statusLinesRef.current.push(line);
  }, []);
  const replaceChapter = useCallback((nextChapter: ChapterSnapshot) => {
    currentChapterRef.current = nextChapter;
    setChapter(nextChapter);
  }, []);
  const reorder = useReorderPagesAction({
    applyChapter,
    currentChapter: chapter,
    currentChapterRef,
    dirty,
    pushStatus,
    refreshLibrary,
    saveNow,
    setCurrentChapter: setChapter,
  });

  useEffect(() => {
    currentChapterRef.current = chapter;
  }, [chapter]);

  useEffect(() => {
    onReady({
      currentChapterRef,
      getChapter: () => chapter,
      getStatusLines: () => statusLinesRef.current,
      replaceChapter,
      reorder,
    });
  }, [chapter, onReady, reorder, replaceChapter]);

  return null;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: Deferred<T>["resolve"] | undefined;
  let rejectPromise: Deferred<T>["reject"] | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (!resolvePromise || !rejectPromise) {
    throw new Error("Failed to initialize deferred promise.");
  }
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

function makeChapter(pageOrder: string[]): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder,
    pages: pageOrder.map(makePage),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(id: string): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
