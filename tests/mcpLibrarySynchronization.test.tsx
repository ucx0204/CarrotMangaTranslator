// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createMangaApi } from "../src/preload/mangaApi";
import { createContractInvoker } from "../src/preload/ipcContracts";
import {
  ipcEventContracts,
  ipcInvokeContracts,
} from "../src/shared/ipcContracts";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import { useMcpEditorSync } from "../src/renderer/src/hooks/useMcpEditorSync";
import {
  mergeLiveChapterPreservingDirtyPages,
  type LiveChapterMergeOptions,
} from "../src/renderer/src/lib/chapterSync";
import { editingChapter } from "./mcpEditing.fixture";

const WORK = "11111111-1111-4111-8111-111111111111";
const CHAPTER = "22222222-2222-4222-8222-222222222222";
const PAGE = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  type Listener = (event: unknown, payload: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  const chapter = editingChapter();
  chapter.workId = WORK;
  chapter.id = CHAPTER;
  chapter.pages[0].id = PAGE;
  chapter.pageOrder = [PAGE];
  chapter.updatedAt = "2026-09-20T11:00:00.000Z";
  const getLibrary = vi.fn(async () => ({
    works: [],
    workOrder: [] as string[],
  }));
  const openChapter = vi.fn(async () => structuredClone(chapter));
  const invoke = vi.fn(async (channel: string) => {
    if (channel === ipcInvokeContracts.getLibrary.channel) return getLibrary();
    if (channel === ipcInvokeContracts.openChapter.channel)
      return openChapter();
    if (channel === ipcInvokeContracts.reportMcpEditorState.channel)
      return { completed: true };
    throw new Error(`Unexpected IPC invocation ${channel}`);
  });
  const warn = vi.fn();
  const api = createMangaApi({
    invoke: createContractInvoker({ invoke }),
    events: {
      on: (channel, listener) => {
        const group = listeners.get(channel) ?? new Set<Listener>();
        group.add(listener);
        listeners.set(channel, group);
      },
      removeListener: (channel, listener) => {
        listeners.get(channel)?.delete(listener);
      },
    },
    getPathForFile: () => "",
    warn,
  });
  vi.stubGlobal("mangaApi", api);
  const currentChapterRef = { current: chapter as ChapterSnapshot | null };
  const dirtyPageIdsRef = { current: new Set([PAGE]) };
  const mergeLiveChapter = vi.fn(
    (live: ChapterSnapshot, options?: LiveChapterMergeOptions) => {
      currentChapterRef.current = mergeLiveChapterPreservingDirtyPages(
        live,
        currentChapterRef.current,
        dirtyPageIdsRef.current,
        options,
      ).chapter;
    },
  );
  const setLibrary = vi.fn();
  const hook = renderHook(() =>
    useMcpEditorSync({
      currentChapterRef,
      dirtyPageIdsRef,
      mergeLiveChapter,
      setLibrary,
      hasPendingInpaintingMask: true,
    }),
  );
  const emit = (
    payload: unknown,
    channel = ipcEventContracts.mcpLibraryChanged.channel,
  ) => {
    act(() => {
      for (const listener of listeners.get(channel) ?? [])
        listener({}, payload);
    });
  };
  return {
    ...hook,
    chapter,
    currentChapterRef,
    getLibrary,
    openChapter,
    mergeLiveChapter,
    setLibrary,
    warn,
    emit,
    invoke,
    listeners,
  };
}

it("refreshes names and library state through the real preload contract while retaining dirty dialogue", async () => {
  const f = fixture();
  f.chapter.pages[0].blocks[0].translatedText = "Unsaved text";
  const saved = structuredClone(f.chapter);
  saved.title = "Saved chapter name";
  saved.pages[0].blocks[0].translatedText = "Older saved text";
  f.openChapter.mockResolvedValue(saved);
  f.emit({ workId: WORK, chapterId: CHAPTER });
  await waitFor(() => expect(f.setLibrary).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(f.currentChapterRef.current?.title).toBe(saved.title),
  );
  expect(f.currentChapterRef.current?.pages[0].blocks[0].translatedText).toBe(
    "Unsaved text",
  );
  f.emit({ workId: WORK, chapterId: CHAPTER, sourcePath: "C:/private" });
  expect(f.warn).toHaveBeenCalledOnce();
  expect(f.getLibrary).toHaveBeenCalledOnce();
  f.emit({ id: 1 }, ipcEventContracts.mcpEditorProbe.channel);
  await waitFor(() =>
    expect(f.invoke).toHaveBeenCalledWith(
      ipcInvokeContracts.reportMcpEditorState.channel,
      {
        probeId: 1,
        chapterId: CHAPTER,
        dirtyPageIds: [PAGE],
        hasPendingInpaintingMask: true,
      },
    ),
  );
});

it("coalesces newer notifications and does not let an earlier read hide restored Undo metadata", async () => {
  const f = fixture();
  const first = deferred<{ works: never[]; workOrder: string[] }>();
  const next = deferred<{ works: never[]; workOrder: string[] }>();
  const firstChapter = deferred<ChapterSnapshot>();
  const nextChapter = deferred<ChapterSnapshot>();
  f.getLibrary
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(next.promise);
  f.openChapter
    .mockReturnValueOnce(firstChapter.promise)
    .mockReturnValueOnce(nextChapter.promise);
  f.emit({ workId: WORK });
  f.emit({ workId: WORK, chapterId: CHAPTER });
  await act(async () => {
    first.resolve({ works: [], workOrder: ["obsolete"] });
    firstChapter.resolve(structuredClone(f.chapter));
  });
  expect(f.setLibrary).not.toHaveBeenCalled();
  expect(f.mergeLiveChapter).not.toHaveBeenCalled();
  expect(f.getLibrary).toHaveBeenCalledTimes(2);
  const restored = structuredClone(f.chapter);
  restored.title = "Original title after Undo";
  restored.updatedAt = "2026-09-20T10:00:00.000Z";
  await act(async () => {
    next.resolve({ works: [], workOrder: ["current"] });
    nextChapter.resolve(restored);
  });
  expect(f.setLibrary).toHaveBeenCalledExactlyOnceWith({
    works: [],
    workOrder: ["current"],
  });
  expect(f.currentChapterRef.current?.title).toBe(restored.title);
});

it("ignores stale chapter reads after navigation and drops library updates after unmount", async () => {
  const f = fixture();
  f.emit({ workId: OTHER });
  await waitFor(() => expect(f.setLibrary).toHaveBeenCalledOnce());
  expect(f.openChapter).not.toHaveBeenCalled();
  const chapterRead = deferred<ChapterSnapshot>();
  const libraryRead = deferred<{ works: never[]; workOrder: string[] }>();
  f.getLibrary.mockReturnValueOnce(libraryRead.promise);
  f.openChapter.mockReturnValueOnce(chapterRead.promise);
  f.emit({ workId: WORK, chapterId: CHAPTER });
  f.currentChapterRef.current = { ...f.chapter, id: OTHER };
  await act(async () => {
    chapterRead.resolve(f.chapter);
  });
  expect(f.mergeLiveChapter).not.toHaveBeenCalled();
  f.unmount();
  await act(async () => {
    libraryRead.resolve({ works: [], workOrder: ["late"] });
  });
  expect(f.setLibrary).toHaveBeenCalledOnce();
  expect([...f.listeners.values()].every((group) => group.size === 0)).toBe(
    true,
  );
});

it("recovers on a later notification after a read failure without executing any save", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = fixture();
  f.getLibrary.mockRejectedValueOnce(new Error("Synthetic read failure"));
  f.emit({ workId: OTHER });
  await waitFor(() => expect(warning).toHaveBeenCalledOnce());
  f.emit({ workId: OTHER });
  await waitFor(() => expect(f.setLibrary).toHaveBeenCalledOnce());
  expect(
    f.invoke.mock.calls.every(
      ([channel]) => channel === ipcInvokeContracts.getLibrary.channel,
    ),
  ).toBe(true);
});
