// @vitest-environment jsdom

import React, { useCallback, useEffect, useRef, useState } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { SavePagesBlocksRequest } from "../src/shared/shareTypes";
import type { TranslationBlock } from "../src/shared/textTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { useChapterPersistence } from "../src/renderer/src/hooks/useChapterPersistence";

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
};

type HarnessApi = {
  getChapter: () => ChapterSnapshot | null;
  getDirty: () => boolean;
  getPersistence: () => ReturnType<typeof useChapterPersistence>;
  refreshSameChapter: () => void;
  rerenderUnrelated: () => void;
  saveNow: () => Promise<void>;
  updateText: (text: string) => void;
  updateTwoPages: (firstText: string, secondText: string) => void;
};

const savePagesBlocksMock =
  vi.fn<(request: SavePagesBlocksRequest) => Promise<ChapterSnapshot>>();

beforeEach(() => {
  savePagesBlocksMock.mockReset();
  window.mangaApi = createTestMangaGatewayStub({
    savePagesBlocks: savePagesBlocksMock,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "mangaApi");
});

describe("chapter persistence save queue", () => {
  it("does not rehash unchanged clean pages after a local edit and saves the latest blocks", async () => {
    savePagesBlocksMock.mockResolvedValue(
      makeChapter("latest local edit", "2026-01-01T00:00:01.000Z"),
    );
    const initialChapter = makeChapter("base", "2026-01-01T00:00:00.000Z");
    let cleanBlockReads = 0;
    observeTranslatedTextReads(initialChapter.pages[1].blocks[0], () => {
      cleanBlockReads += 1;
    });
    const { api } = renderHarness(undefined, initialChapter);
    cleanBlockReads = 0;

    act(() => {
      api.current.updateText("latest local edit");
    });

    expect(cleanBlockReads).toBe(0);
    expect(api.current.getPersistence().saveStatus).toBe("dirty");

    await act(async () => {
      await api.current.saveNow();
    });

    expect(savePagesBlocksMock).toHaveBeenCalledOnce();
    expect(savePagesBlocksMock.mock.calls[0][0]).toMatchObject({
      pages: [
        {
          baseUpdatedAt: "2026-01-01T00:00:00.000Z",
          blocks: [{ translatedText: "latest local edit" }],
          pageId: "page-1",
        },
      ],
    });
    expect(api.current.getChapter()?.pages[0].blocks[0].translatedText).toBe(
      "latest local edit",
    );
    expect(api.current.getDirty()).toBe(false);
    expect(api.current.getPersistence().saveStatus).toBe("saved");
  });

  it("serializes overlapping manual saves and resaves the latest chapter state", async () => {
    const firstSave = createDeferred<ChapterSnapshot>();
    const secondSave = createDeferred<ChapterSnapshot>();
    savePagesBlocksMock
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise);
    const { api } = renderHarness();

    act(() => {
      api.current.updateText("first");
    });
    const firstSaveNow = api.current.saveNow();

    await waitFor(() => {
      expect(savePagesBlocksMock).toHaveBeenCalledTimes(1);
    });
    expect(savePagesBlocksMock.mock.calls[0][0]).toMatchObject({
      dirtyVersion: 1,
      pages: [
        {
          baseUpdatedAt: "2026-01-01T00:00:00.000Z",
          pageId: "page-1",
        },
      ],
      saveReason: "manual",
    });
    expect(
      savePagesBlocksMock.mock.calls[0][0].pages[0]?.blocks[0]?.translatedText,
    ).toBe("first");

    act(() => {
      api.current.updateText("second");
    });
    const secondSaveNow = api.current.saveNow();
    await flushMicrotasks();

    expect(savePagesBlocksMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve(makeChapter("first", "2026-01-01T00:00:01.000Z"));
      await firstSave.promise;
    });

    await waitFor(() => {
      expect(savePagesBlocksMock).toHaveBeenCalledTimes(2);
    });
    expect(savePagesBlocksMock.mock.calls[1][0]).toMatchObject({
      dirtyVersion: 2,
      pages: [
        {
          baseUpdatedAt: "2026-01-01T00:00:01.000Z",
          pageId: "page-1",
        },
      ],
      saveReason: "manual",
    });
    expect(
      savePagesBlocksMock.mock.calls[1][0].pages[0]?.blocks[0]?.translatedText,
    ).toBe("second");

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
    savePagesBlocksMock.mockReturnValue(saveGate.promise);
    const { api } = renderHarness();

    act(() => {
      api.current.updateText("one draft");
    });
    const firstSave = api.current.saveNow();
    const duplicateSave = api.current.saveNow();

    await waitFor(() => {
      expect(savePagesBlocksMock).toHaveBeenCalledOnce();
    });
    await act(async () => {
      saveGate.resolve(makeChapter("one draft", "2026-01-01T00:00:01.000Z"));
      await Promise.all([firstSave, duplicateSave]);
    });

    expect(savePagesBlocksMock).toHaveBeenCalledOnce();
    expect(api.current.getDirty()).toBe(false);
    expect(api.current.getChapter()?.pages[0].blocks[0].translatedText).toBe(
      "one draft",
    );
  });

  it("rejects every waiter on queue failure and allows a later retry", async () => {
    const failure = new Error("storage unavailable");
    savePagesBlocksMock
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
    expect(savePagesBlocksMock).toHaveBeenCalledOnce();
    expect(api.current.getDirty()).toBe(true);
    expect(api.current.getPersistence().saveStatus).toBe("error");
    expect(api.current.getChapter()?.pages[0].blocks[0].translatedText).toBe(
      "retry draft",
    );

    await act(async () => {
      await api.current.saveNow();
    });

    expect(savePagesBlocksMock).toHaveBeenCalledTimes(2);
    expect(savePagesBlocksMock.mock.calls[1][0]).toMatchObject({
      dirtyVersion: 1,
      pages: [
        {
          baseUpdatedAt: "2026-01-01T00:00:00.000Z",
          pageId: "page-1",
        },
      ],
      saveReason: "manual",
    });
    expect(api.current.getDirty()).toBe(false);
    expect(api.current.getPersistence().saveStatus).toBe("saved");
  });

  it("persists every dirty page in one batch request", async () => {
    savePagesBlocksMock.mockResolvedValue(
      makeChapterWithPageTexts(
        "first page saved",
        "second page saved",
        "2026-01-01T00:00:01.000Z",
      ),
    );
    const { api } = renderHarness();

    act(() => {
      api.current.updateTwoPages("first page saved", "second page saved");
    });
    await act(async () => {
      await api.current.saveNow();
    });

    expect(savePagesBlocksMock).toHaveBeenCalledOnce();
    expect(savePagesBlocksMock.mock.calls[0][0]).toMatchObject({
      dirtyVersion: 2,
      pages: [
        {
          baseUpdatedAt: "2026-01-01T00:00:00.000Z",
          pageId: "page-1",
          blocks: [{ translatedText: "first page saved" }],
        },
        {
          baseUpdatedAt: "2026-01-01T00:00:00.000Z",
          pageId: "page-2",
          blocks: [{ translatedText: "second page saved" }],
        },
      ],
      saveReason: "manual",
    });
    expect(api.current.getChapter()?.pages.map(firstTranslatedText)).toEqual([
      "first page saved",
      "second page saved",
    ]);
    expect(api.current.getDirty()).toBe(false);
  });

  it("converts a stale server version into a page-save conflict without losing edits", async () => {
    const staleError = Object.assign(new Error("stale version"), {
      code: "STALE_PAGE_SAVE",
    });
    savePagesBlocksMock.mockRejectedValue(staleError);
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

    expect(savePagesBlocksMock).toHaveBeenCalledOnce();
    expect(api.current.getDirty()).toBe(true);
    expect(api.current.getPersistence().saveStatus).toBe("conflict");
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

    expect(savePagesBlocksMock).not.toHaveBeenCalled();
  });

  it("does not postpone autosave when unrelated session state rerenders", async () => {
    vi.useFakeTimers();
    savePagesBlocksMock.mockResolvedValue(
      makeChapter("stable timer draft", "2026-01-01T00:00:01.000Z"),
    );
    const { api } = renderHarness();

    act(() => {
      api.current.updateText("stable timer draft");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    act(() => {
      api.current.rerenderUnrelated();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(savePagesBlocksMock).toHaveBeenCalledOnce();
  });

  it("does not postpone autosave for a same-chapter job snapshot refresh", async () => {
    vi.useFakeTimers();
    savePagesBlocksMock.mockResolvedValue(
      makeChapter("stable timer draft", "2026-01-01T00:00:01.000Z"),
    );
    const { api } = renderHarness();

    act(() => {
      api.current.updateText("stable timer draft");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    act(() => {
      api.current.refreshSameChapter();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(savePagesBlocksMock).toHaveBeenCalledOnce();
  });

  it("still debounces from the latest semantic edit", async () => {
    vi.useFakeTimers();
    savePagesBlocksMock.mockResolvedValue(
      makeChapter("second edit", "2026-01-01T00:00:01.000Z"),
    );
    const { api } = renderHarness();

    act(() => {
      api.current.updateText("first edit");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    act(() => {
      api.current.updateText("second edit");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(savePagesBlocksMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(savePagesBlocksMock).toHaveBeenCalledOnce();
  });

  it("keeps the persistence action boundary stable on unrelated root rerenders", () => {
    const chapter = makeChapter("base", "2026-01-01T00:00:00.000Z");
    const pagesIterator = vi.spyOn(chapter.pages, Symbol.iterator);
    const { api } = renderHarness(undefined, chapter);
    const initialPersistence = api.current.getPersistence();
    pagesIterator.mockClear();

    act(() => {
      api.current.rerenderUnrelated();
    });

    expect(api.current.getPersistence()).toBe(initialPersistence);
    expect(pagesIterator).not.toHaveBeenCalled();
  });

  it("deduplicates repeated autosave error notifications within the cooldown", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onSaveError = vi.fn();
    savePagesBlocksMock.mockRejectedValue(new Error("storage unavailable"));
    const { api } = renderHarness(onSaveError);

    act(() => {
      api.current.updateText("first failing autosave");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(savePagesBlocksMock).toHaveBeenCalledOnce();
    expect(onSaveError).toHaveBeenCalledWith("storage unavailable");

    act(() => {
      api.current.updateText("second failing autosave");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(savePagesBlocksMock).toHaveBeenCalledTimes(2);
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
    expect(savePagesBlocksMock).toHaveBeenCalledTimes(3);
    expect(onSaveError).toHaveBeenCalledTimes(2);
  });
});

function renderHarness(
  onSaveError?: (message: string) => void,
  initialChapter = makeChapter("base", "2026-01-01T00:00:00.000Z"),
): {
  api: React.MutableRefObject<HarnessApi>;
  unmount: () => void;
} {
  const api = React.createRef<HarnessApi>();

  const { unmount } = render(
    React.createElement(ChapterPersistenceHarness, {
      initialChapter,
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
  initialChapter,
  onSaveError,
  onReady,
}: {
  initialChapter: ChapterSnapshot;
  onSaveError?: (message: string) => void;
  onReady: (api: HarnessApi) => void;
}): React.JSX.Element | null {
  const [chapter, setChapterState] = useState<ChapterSnapshot | null>(
    initialChapter,
  );
  const [, setUnrelatedRevision] = useState(0);
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
    onSaveError: (message) => onSaveError?.(message),
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

  const updateTwoPages = useCallback(
    (firstText: string, secondText: string) => {
      const chapter = currentChapterRef.current;
      if (!chapter) {
        return;
      }
      const next = updateChapterTexts(
        chapter,
        new Map([
          ["page-1", firstText],
          ["page-2", secondText],
        ]),
      );
      currentChapterRef.current = next;
      setChapterState(next);
      persistence.markDirty("page-1");
      persistence.markDirty("page-2");
    },
    [persistence],
  );

  useEffect(() => {
    onReady({
      getChapter: () => currentChapterRef.current,
      getDirty: () => persistence.dirty,
      getPersistence: () => persistence,
      refreshSameChapter: () => {
        const current = currentChapterRef.current;
        if (current) {
          const refreshed = { ...current };
          currentChapterRef.current = refreshed;
          setChapterState(refreshed);
        }
      },
      rerenderUnrelated: () => setUnrelatedRevision((revision) => revision + 1),
      saveNow: persistence.saveNow,
      updateText,
      updateTwoPages,
    });
  }, [
    onReady,
    persistence.dirty,
    persistence.saveNow,
    persistence.saveStatus,
    updateText,
    updateTwoPages,
  ]);

  return null;
}

function updateChapterText(
  chapter: ChapterSnapshot,
  text: string,
): ChapterSnapshot {
  return updateChapterTexts(chapter, new Map([["page-1", text]]));
}

function updateChapterTexts(
  chapter: ChapterSnapshot,
  textsByPageId: ReadonlyMap<string, string>,
): ChapterSnapshot {
  return {
    ...chapter,
    pages: chapter.pages.map((page) => {
      const text = textsByPageId.get(page.id);
      return text !== undefined
        ? {
            ...page,
            blocks: page.blocks.map((block) => ({
              ...block,
              translatedText: text,
            })),
          }
        : page;
    }),
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
  return makeChapterWithPageTexts(text, "base page two", updatedAt);
}

function makeChapterWithPageTexts(
  firstText: string,
  secondText: string,
  updatedAt: string,
): ChapterSnapshot {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    workId: "11111111-1111-4111-8111-111111111111",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page-1", "page-2"],
    pages: [
      makePage("page-1", firstText, updatedAt),
      makePage("page-2", secondText, updatedAt),
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

function makePage(id: string, text: string, updatedAt: string): MangaPage {
  return {
    id,
    name: `${id}.png`,
    imagePath: `${id}.png`,
    dataUrl: "",
    width: 1000,
    height: 1000,
    blocks: [makeBlock(text)],
    analysisStatus: "idle",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

function firstTranslatedText(page: MangaPage): string | undefined {
  return page.blocks[0]?.translatedText;
}

function observeTranslatedTextReads(
  block: TranslationBlock,
  onRead: () => void,
): void {
  const translatedText = block.translatedText;
  Object.defineProperty(block, "translatedText", {
    configurable: true,
    enumerable: true,
    get: () => {
      onRead();
      return translatedText;
    },
  });
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
