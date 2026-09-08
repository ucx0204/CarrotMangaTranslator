/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRestoreSoundEffectReviewAction } from "../src/renderer/src/hooks/useRestoreSoundEffectReviewAction";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";

const chapter: ChapterSnapshot = {
  id: "chapter",
  workId: "work",
  title: "1",
  sourceKind: "images",
  status: "completed",
  pages: [],
  pageOrder: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};
const previousBridge = window.mangaApi;
afterEach(() => {
  cleanup();
  window.mangaApi = previousBridge;
});

describe("SFX restoration through the library gateway", () => {
  it("flushes unsaved page edits before restoring and applies the returned chapter", async () => {
    const calls: string[] = [];
    const restore = vi.fn(async () => {
      calls.push("restore");
      return chapter;
    });
    window.mangaApi = createTestMangaGatewayStub({
      restoreSoundEffectReview: restore,
    });
    const applyChapter = vi.fn(() => {
      calls.push("apply");
    });
    const { result } = renderHook(() =>
      useRestoreSoundEffectReviewAction({
        currentChapterRef: { current: chapter },
        dirty: true,
        saveNow: async () => {
          calls.push("save");
        },
        applyChapter,
      }),
    );
    await act(async () => {
      expect(await result.current({ chapterId: chapter.id, pages: [] })).toBe(
        chapter,
      );
    });
    expect(calls).toEqual(["save", "restore", "apply"]);
    expect(restore).toHaveBeenCalledWith({ chapterId: chapter.id, pages: [] });
  });

  it("does not overwrite a different chapter opened while restoration was running", async () => {
    const ref = { current: chapter as ChapterSnapshot | null };
    window.mangaApi = createTestMangaGatewayStub({
      restoreSoundEffectReview: async () => {
        ref.current = null;
        return chapter;
      },
    });
    const applyChapter = vi.fn();
    const saveNow = vi.fn();
    const { result } = renderHook(() =>
      useRestoreSoundEffectReviewAction({
        currentChapterRef: ref,
        dirty: false,
        saveNow,
        applyChapter,
      }),
    );
    await act(async () => {
      await result.current({ chapterId: chapter.id, pages: [] });
    });
    expect(saveNow).not.toHaveBeenCalled();
    expect(applyChapter).not.toHaveBeenCalled();
  });

  it("propagates save failures and rejects a stale chapter before IPC", async () => {
    const restore = vi.fn(async () => chapter);
    window.mangaApi = createTestMangaGatewayStub({
      restoreSoundEffectReview: restore,
    });
    const saveNow = vi.fn<() => Promise<void>>(async () => {
      throw new Error("save failed");
    });
    const ref = { current: chapter as ChapterSnapshot | null };
    const { result } = renderHook(() =>
      useRestoreSoundEffectReviewAction({
        currentChapterRef: ref,
        dirty: true,
        saveNow,
        applyChapter: vi.fn(),
      }),
    );
    await expect(
      result.current({ chapterId: chapter.id, pages: [] }),
    ).rejects.toThrow("save failed");
    saveNow.mockResolvedValueOnce(undefined);
    ref.current = null;
    await expect(
      result.current({ chapterId: chapter.id, pages: [] }),
    ).rejects.toThrow(/화가 변경/);
    expect(restore).not.toHaveBeenCalled();
  });
});
