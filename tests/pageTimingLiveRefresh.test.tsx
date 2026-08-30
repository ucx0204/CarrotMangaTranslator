/** @vitest-environment jsdom */

import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type { PageTimingUpdatedEvent } from "../src/shared/pageProcessingTiming";
import { useJobEvents } from "../src/renderer/src/hooks/useJobEvents";
import type { JobState } from "../src/shared/jobTypes";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";

afterEach(() => {
  window.mangaApi = createTestMangaGatewayStub();
});

describe("page timing live refresh", () => {
  it("rereads the open chapter immediately after a timing checkpoint event", async () => {
    const chapter = makeChapter();
    const refreshed = {
      ...chapter,
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    let timingListener: ((event: PageTimingUpdatedEvent) => void) | undefined;
    const openChapter = vi.fn(async () => refreshed);
    const mergeLiveChapter = vi.fn();
    const currentChapterRef = {
      current: chapter,
    } as React.MutableRefObject<ChapterSnapshot | null>;

    renderHook(() =>
      useJobEvents({
        appendStatusLine: vi.fn(),
        currentChapterRef,
        jobState: idleJobState(),
        mergeLiveChapter,
        openChapter,
        setJobState: vi.fn(),
        subscribeJobEvents: () => vi.fn(),
        subscribePageTimingUpdates: (listener) => {
          timingListener = listener;
          return vi.fn();
        },
      }),
    );

    timingListener?.({ chapterId: chapter.id, pageIds: ["page-1"] });

    await waitFor(() => expect(openChapter).toHaveBeenCalledWith(chapter.id));
    expect(mergeLiveChapter).toHaveBeenCalledWith(refreshed);
  });

  it("skips timing subscription when only a custom job stream is supplied", () => {
    const unsubscribeJobs = vi.fn();
    const { unmount } = renderHook(() =>
      useJobEvents({
        appendStatusLine: vi.fn(),
        currentChapterRef: { current: makeChapter() },
        jobState: idleJobState(),
        mergeLiveChapter: vi.fn(),
        setJobState: vi.fn(),
        subscribeJobEvents: () => unsubscribeJobs,
      }),
    );

    unmount();
    expect(unsubscribeJobs).toHaveBeenCalledOnce();
  });

  it("uses both bridge event streams when no test subscriptions are supplied", () => {
    const unsubscribeJobs = vi.fn();
    const unsubscribeTiming = vi.fn();
    const onJobEvent = vi.fn(() => unsubscribeJobs);
    const onPageTimingUpdated = vi.fn(() => unsubscribeTiming);
    window.mangaApi = createTestMangaGatewayStub({
      onJobEvent,
      onPageTimingUpdated,
    });
    const { unmount } = renderHook(() =>
      useJobEvents({
        appendStatusLine: vi.fn(),
        currentChapterRef: { current: makeChapter() },
        jobState: idleJobState(),
        mergeLiveChapter: vi.fn(),
        setJobState: vi.fn(),
      }),
    );

    expect(onJobEvent).toHaveBeenCalledOnce();
    expect(onPageTimingUpdated).toHaveBeenCalledOnce();
    unmount();
    expect(unsubscribeJobs).toHaveBeenCalledOnce();
    expect(unsubscribeTiming).toHaveBeenCalledOnce();
  });
});

function idleJobState(): JobState {
  return {
    id: "idle",
    kind: "gemma-analysis",
    progressText: "",
    status: "idle",
  };
}

function makeChapter(): ChapterSnapshot {
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: ["page-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    pages: [
      {
        id: "page-1",
        name: "001.png",
        imagePath: "C:/page-1.png",
        dataUrl: "",
        width: 100,
        height: 100,
        blocks: [],
        analysisStatus: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}
