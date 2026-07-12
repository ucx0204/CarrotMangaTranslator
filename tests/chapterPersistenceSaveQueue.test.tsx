// @vitest-environment jsdom

import React, { useCallback, useEffect, useRef, useState } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MangaApi } from "../src/shared/mangaApi";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { SavePageBlocksRequest } from "../src/shared/shareTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { useChapterPersistence } from "../src/renderer/src/hooks/useChapterPersistence";

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
};

type HarnessApi = {
  getChapter: () => ChapterSnapshot | null;
  getDirty: () => boolean;
  saveNow: () => Promise<void>;
  updateText: (text: string) => void;
};

const savePageBlocksMock =
  vi.fn<(request: SavePageBlocksRequest) => Promise<ChapterSnapshot>>();

beforeEach(() => {
  savePageBlocksMock.mockReset();
  (window as unknown as { mangaApi: Partial<MangaApi> }).mangaApi = {
    savePageBlocks: savePageBlocksMock,
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { mangaApi?: Partial<MangaApi> }).mangaApi;
});

describe("chapter persistence save queue", () => {
  it("serializes overlapping manual saves and resaves the latest chapter state", async () => {
    const firstSave = createDeferred<ChapterSnapshot>();
    const secondSave = createDeferred<ChapterSnapshot>();
    savePageBlocksMock
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const { api } = renderHarness();

    act(() => {
      api.current.updateText("first");
    });
    const firstSaveNow = api.current.saveNow();

    await waitFor(() => {
      expect(savePageBlocksMock).toHaveBeenCalledTimes(1);
    });
    expect(savePageBlocksMock.mock.calls[0][0]).toMatchObject({
      baseUpdatedAt: "2026-01-01T00:00:00.000Z",
      dirtyVersion: 1,
      saveReason: "manual",
    });
    expect(savePageBlocksMock.mock.calls[0][0].blocks[0].translatedText).toBe(
      "first",
    );

    act(() => {
      api.current.updateText("second");
    });
    const secondSaveNow = api.current.saveNow();
    await flushMicrotasks();

    expect(savePageBlocksMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve(makeChapter("first", "2026-01-01T00:00:01.000Z"));
      await firstSave.promise;
    });

    await waitFor(() => {
      expect(savePageBlocksMock).toHaveBeenCalledTimes(2);
    });
    expect(savePageBlocksMock.mock.calls[1][0]).toMatchObject({
      baseUpdatedAt: "2026-01-01T00:00:01.000Z",
      dirtyVersion: 2,
      saveReason: "manual",
    });
    expect(savePageBlocksMock.mock.calls[1][0].blocks[0].translatedText).toBe(
      "second",
    );

    await act(async () => {
      secondSave.resolve(makeChapter("second", "2026-01-01T00:00:02.000Z"));
      await Promise.all([firstSaveNow, secondSaveNow]);
    });

    expect(api.current.getChapter()?.pages[0].blocks[0].translatedText).toBe(
      "second",
    );
    expect(api.current.getDirty()).toBe(false);
  });

  it("coalesces identical overlapping manual saves into one persistence call", async () => {
    const saveGate = createDeferred<ChapterSnapshot>();
    savePageBlocksMock.mockReturnValue(saveGate.promise);
    const { api } = renderHarness();

    act(() => {
      api.current.updateText("one draft");
    });
    const firstSave = api.current.saveNow();
    const duplicateSave = api.current.saveNow();

    await waitFor(() => {
      expect(savePageBlocksMock).toHaveBeenCalledOnce();
    });
    await act(async () => {
      saveGate.resolve(makeChapter("one draft", "2026-01-01T00:00:01.000Z"));
      await Promise.all([firstSave, duplicateSave]);
    });

    expect(savePageBlocksMock).toHaveBeenCalledOnce();
    expect(api.current.getDirty()).toBe(false);
    expect(api.current.getChapter()?.pages[0].blocks[0].translatedText).toBe(
      "one draft",
    );
  });

  it("rejects every waiter on queue failure and allows a later retry", async () => {
    const failure = new Error("storage unavailable");
    savePageBlocksMock
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(
        makeChapter("retry draft", "2026-01-01T00:00:01.000Z"),
      );
    const { api } = renderHarness();

    act(() => {
      api.current.updateText("retry draft");
    });
    const firstSave = api.current.saveNow();
    const waitingSave = api.current.saveNow();

    await act(async () => {
      await expect(Promise.all([firstSave, waitingSave])).rejects.toBe(failure);
    });
    expect(savePageBlocksMock).toHaveBeenCalledOnce();
    expect(api.current.getDirty()).toBe(true);
    expect(api.current.getChapter()?.pages[0].blocks[0].translatedText).toBe(
      "retry draft",
    );

    await act(async () => {
      await api.current.saveNow();
    });

    expect(savePageBlocksMock).toHaveBeenCalledTimes(2);
    expect(savePageBlocksMock.mock.calls[1][0]).toMatchObject({
      baseUpdatedAt: "2026-01-01T00:00:00.000Z",
      dirtyVersion: 1,
      saveReason: "manual",
    });
    expect(api.current.getDirty()).toBe(false);
  });

  it("converts a stale server version into a page-save conflict without losing edits", async () => {
    const staleError = Object.assign(new Error("stale version"), {
      code: "STALE_PAGE_SAVE",
    });
    savePageBlocksMock.mockRejectedValue(staleError);
    const { api } = renderHarness();

    act(() => {
      api.current.updateText("unsaved conflict draft");
    });

    await act(async () => {
      await expect(api.current.saveNow()).rejects.toMatchObject({
        code: "PAGE_SAVE_CONFLICT",
        message:
          "페이지 저장 충돌이 발생했습니다. 최신 내용을 확인한 뒤 다시 저장해 주세요.",
      });
    });

    expect(savePageBlocksMock).toHaveBeenCalledOnce();
    expect(api.current.getDirty()).toBe(true);
    expect(api.current.getChapter()?.pages[0].blocks[0].translatedText).toBe(
      "unsaved conflict draft",
    );
  });

  it("cancels a scheduled autosave when the editor unmounts", async () => {
    vi.useFakeTimers();
    const { api, unmount } = renderHarness();

    act(() => {
      api.current.updateText("unmounted draft");
    });
    expect(api.current.getDirty()).toBe(true);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(savePageBlocksMock).not.toHaveBeenCalled();
  });

  it("deduplicates repeated autosave error notifications within the cooldown", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onSaveError = vi.fn();
    savePageBlocksMock.mockRejectedValue(new Error("storage unavailable"));
    const { api } = renderHarness(onSaveError);

    act(() => {
      api.current.updateText("first failing autosave");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(savePageBlocksMock).toHaveBeenCalledOnce();
    expect(onSaveError).toHaveBeenCalledWith("storage unavailable");

    act(() => {
      api.current.updateText("second failing autosave");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(savePageBlocksMock).toHaveBeenCalledTimes(2);
    expect(onSaveError).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });
    act(() => {
      api.current.updateText("third failing autosave");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(savePageBlocksMock).toHaveBeenCalledTimes(3);
    expect(onSaveError).toHaveBeenCalledTimes(2);
  });
});

function renderHarness(onSaveError?: (message: string) => void): {
  api: React.MutableRefObject<HarnessApi>;
  unmount: () => void;
} {
  const api = React.createRef<HarnessApi>();

  const { unmount } = render(
    React.createElement(ChapterPersistenceHarness, {
      onSaveError,
      onReady: (nextApi: HarnessApi) => {
        api.current = nextApi;
      },
    }),
  );

  if (!api.current) {
    throw new Error("Chapter persistence harness did not initialize.");
  }
  return {
    api: api as React.MutableRefObject<HarnessApi>,
    unmount,
  };
}

function ChapterPersistenceHarness({
  onSaveError,
  onReady,
}: {
  onSaveError?: (message: string) => void;
  onReady: (api: HarnessApi) => void;
}): React.JSX.Element | null {
  const [chapter, setChapterState] = useState<ChapterSnapshot | null>(() =>
    makeChapter("base", "2026-01-01T00:00:00.000Z"),
  );
  const currentChapterRef = useRef<ChapterSnapshot | null>(chapter);
  const setCurrentChapter = useCallback<
    React.Dispatch<React.SetStateAction<ChapterSnapshot | null>>
  >((value) => {
    setChapterState((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      currentChapterRef.current = next;
      return next;
    });
  }, []);
  const persistence = useChapterPersistence({
    currentChapter: chapter,
    currentChapterRef,
    onSaveError,
    setCurrentChapter,
  });

  const updateText = useCallback(
    (text: string) => {
      const chapter = currentChapterRef.current;
      if (!chapter) {
        return;
      }
      const next = updateChapterText(chapter, text);
      currentChapterRef.current = next;
      setChapterState(next);
      persistence.markDirty("page-1");
    },
    [persistence],
  );

  useEffect(() => {
    onReady({
      getChapter: () => currentChapterRef.current,
      getDirty: () => persistence.dirty,
      saveNow: persistence.saveNow,
      updateText,
    });
  }, [onReady, persistence.dirty, persistence.saveNow, updateText]);

  return null;
}

function updateChapterText(
  chapter: ChapterSnapshot,
  text: string,
): ChapterSnapshot {
  return {
    ...chapter,
    pages: chapter.pages.map((page) =>
      page.id === "page-1"
        ? {
            ...page,
            blocks: page.blocks.map((block) => ({
              ...block,
              translatedText: text,
            })),
          }
        : page,
    ),
  };
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeChapter(text: string, updatedAt: string): ChapterSnapshot {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workId: "11111111-1111-4111-8111-111111111111",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page-1"],
    pages: [makePage(text, updatedAt)],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

function makePage(text: string, updatedAt: string): MangaPage {
  return {
    id: "page-1",
    name: "page-1.png",
    imagePath: "page-1.png",
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [makeBlock(text)],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

function makeBlock(text: string): TranslationBlock {
  return {
    id: "block-1",
    type: "nonsolid",
    bbox: { x: 100, y: 100, w: 200, h: 200 },
    sourceText: "source",
    translatedText: text,
    confidence: 1,
    sourceDirection: "horizontal",
    renderDirection: "horizontal",
    fontSizePx: 32,
    lineHeight: 1.2,
    textAlign: "center",
    textColor: "#ffffff",
    backgroundColor: "transparent",
    opacity: 1,
  };
}
