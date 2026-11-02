// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useJobEvents } from "../src/renderer/src/hooks/useJobEvents";
import { useStatusLog } from "../src/renderer/src/hooks/useStatusLog";
import { useLiveChapterSync } from "../src/renderer/src/hooks/useLiveChapterSync";
import { createTestMangaGatewayStub } from "../src/renderer/src/api/mangaGateway";
import { makeChapter, makePage } from "./helpers/workspacePointerFixtures";
import { initializeAppI18n } from "../src/renderer/src/appI18n";
import { JobEventSchema } from "../src/shared/ipcJobSchemas";
import type { JobEvent, JobState } from "../src/shared/jobTypes";
import type { ChapterSnapshot, LibraryIndex } from "../src/shared/libraryTypes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("refreshes saved pages and chapter rows mid-run, preserves edits, and logs the actual background chapter", async () => {
  await initializeAppI18n("ko");
  const chapter = makeChapter(
    makePage({ blockPatch: { translatedText: "unsaved user text" } }),
  );
  const untouched = { ...makePage(), id: "page-2" };
  chapter.pages.push(untouched);
  chapter.pageOrder.push(untouched.id);
  const saved = structuredClone(chapter);
  saved.status = "completed";
  saved.pages.forEach((p) => {
    p.analysisStatus = "completed";
    p.blocks[0].translatedText = "saved translation";
    p.inpaintedImagePath = "saved-clean.png";
  });
  const background = { ...chapter, id: "chapter-2", title: "2화" };
  const summary = (c: typeof chapter) => ({
    id: c.id,
    workId: c.workId,
    title: c.title,
    status: c.status,
    pageCount: c.pages.length,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
  const initialLibrary: LibraryIndex = {
    workOrder: [chapter.workId],
    works: [
      {
        id: chapter.workId,
        title: "작품",
        chapterOrder: [chapter.id, background.id],
        createdAt: chapter.createdAt,
        updatedAt: chapter.updatedAt,
        chapters: [summary(chapter), summary(background)],
      },
    ],
  };
  const savedLibrary = structuredClone(initialLibrary);
  savedLibrary.works[0].chapters.forEach((c) => {
    c.status = "completed";
  });
  vi.stubGlobal(
    "mangaApi",
    createTestMangaGatewayStub({ getLibrary: async () => savedLibrary }),
  );
  const openChapter = vi.fn(async () => saved);
  let listener!: (event: JobEvent) => void;
  const subscribeJobEvents = (fn: typeof listener) => {
    listener = fn;
    return () => {};
  };
  const currentChapterRef = { current: chapter as ChapterSnapshot | null };
  const dirtyPageIdsRef = { current: new Set([chapter.pages[0].id]) };
  const setSelection = vi.fn();
  const { result } = renderHook(() => {
    const [current, setCurrent] = React.useState<ChapterSnapshot | null>(
      chapter,
    );
    const [library, setLibrary] = React.useState(initialLibrary);
    const [job, setJob] = React.useState<JobState>({
      id: "run",
      kind: "gemma-analysis",
      status: "running",
      progressText: "",
    });
    const log = useStatusLog({ currentChapter: current, library });
    const mergeLiveChapter = useLiveChapterSync({
      currentChapter: current,
      currentChapterRef,
      dirtyPageIdsRef,
      replaceDirtyPageIds: (ids) => {
        dirtyPageIdsRef.current = new Set(ids);
      },
      selectedBlockId: null,
      selectedBlockIdRef: { current: null },
      selectedPageId: chapter.pages[0].id,
      selectedPageIdRef: { current: chapter.pages[0].id },
      setCurrentChapter: setCurrent,
      setSelectedBlockId: setSelection,
      setSelectedPageId: setSelection,
    });
    useJobEvents({
      appendStatusLine: log.appendStatusLine,
      currentChapterRef,
      mergeLiveChapter,
      openChapter,
      setJobState: setJob,
      setLibrary,
      subscribeJobEvents,
    });
    return { current, library, log, job };
  });
  const event = (chapterId: string): JobEvent =>
    JobEventSchema.parse({
      id: "run",
      kind: "gemma-analysis",
      status: "running",
      phase: "page_done",
      progressText: "저장된 단계",
      progressCurrent: 42,
      progressTotal: 1624,
      workflowProgress: { pageCount: 232, stageCount: 7, chapterId },
    });
  act(() => listener(event(chapter.id)));
  await waitFor(() =>
    expect(result.current.library.works[0].chapters[0].status).toBe(
      "completed",
    ),
  );
  await waitFor(() =>
    expect(result.current.current?.pages[1].blocks[0].translatedText).toBe(
      "saved translation",
    ),
  );
  expect(result.current.current?.pages[0].blocks[0].translatedText).toBe(
    "unsaved user text",
  );
  expect(result.current.current?.pages[1].inpaintedImagePath).toBe(
    "saved-clean.png",
  );
  expect(result.current.job.status).toBe("running");
  const reads = openChapter.mock.calls.length;
  act(() =>
    listener({
      ...event(background.id),
      progressText: "2화 · 원문 제거 · 021.jpg 분석 중",
    }),
  );
  await waitFor(() =>
    expect(result.current.log.statusEntries[0].context?.chapterTitle).toBe(
      "2화",
    ),
  );
  expect(openChapter).toHaveBeenCalledTimes(reads);
});
