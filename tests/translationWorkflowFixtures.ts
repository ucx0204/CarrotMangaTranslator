import { vi } from "vitest";
import type { ChapterSnapshot, MangaPage } from "../src/shared/libraryTypes";
import type { UseTranslationActionsOptions } from "../src/renderer/src/hooks/translationActionTypes";
const TS = "2026-01-01T00:00:00.000Z";

export function makePage(): MangaPage {
  return {
    id: "page-1",
    name: "page.png",
    imagePath: "C:/page.png",
    dataUrl: "",
    width: 100,
    height: 150,
    blocks: [],
    analysisStatus: "idle",
    createdAt: TS,
    updatedAt: TS,
  };
}

export function makeChapter(): ChapterSnapshot {
  const page = makePage();
  return {
    id: "chapter-1",
    workId: "work-1",
    title: "1화",
    sourceKind: "images",
    status: "idle",
    pageOrder: [page.id],
    pages: [page],
    createdAt: TS,
    updatedAt: TS,
  };
}

export function makeOptions(): UseTranslationActionsOptions {
  const chapter = makeChapter();
  return {
    clearPageImageCache: vi.fn(),
    clearRetouchHistory: vi.fn(),
    currentChapter: chapter,
    currentChapterRef: { current: chapter },
    jobActive: false,
    library: { workOrder: [], works: [] },
    mergeLiveChapter: vi.fn(),
    pushStatus: vi.fn(),
    refreshLibrary: vi.fn().mockResolvedValue(undefined),
    recordImageEdit: vi.fn(),
    saveNow: vi.fn().mockResolvedValue(undefined),
    selectedPage: null,
    setCurrentChapter: vi.fn(),
    setFlowActive: vi.fn(),
    setShowBlockChrome: vi.fn(),
    setJobState: vi.fn(),
    setSelectedBlockId: vi.fn(),
    syncSavedPageVersion: vi.fn(),
  };
}
