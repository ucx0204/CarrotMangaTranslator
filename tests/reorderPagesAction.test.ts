// @vitest-environment jsdom

import React, { useCallback, useEffect, useRef, useState } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  reorder: (sourcePageId: string, targetPageId: string) => void;
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
});

function renderHarness({
  dirty,
  saveNow,
}: {
  dirty: boolean;
  saveNow: () => Promise<void>;
}): React.MutableRefObject<HarnessApi> {
  const api = React.createRef<HarnessApi>();

  render(
    React.createElement(ReorderPagesHarness, {
      dirty,
      onReady: (nextApi: HarnessApi) => {
        api.current = nextApi;
      },
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
  saveNow,
}: {
  dirty: boolean;
  onReady: (api: HarnessApi) => void;
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
  const refreshLibrary = useCallback(async () => undefined, []);
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
      reorder,
    });
  }, [chapter, onReady, reorder]);

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
