import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../src/shared/workContextTypes";

const saveChapterStoryMemory = vi.hoisted(() => vi.fn());
const saveWorkStyleGuide = vi.hoisted(() => vi.fn());

vi.mock("../src/main/library", () => ({
  saveChapterStoryMemory,
  saveWorkStyleGuide,
}));
vi.mock("../src/main/logger", () => ({ logWarn: vi.fn() }));

import { persistPageContextAfterSuccess } from "../src/main/pipeline/pageContextPersistence";
import { createWarningCollector } from "../src/main/pipeline/warningCollector";

const NOW = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  saveChapterStoryMemory.mockImplementation(async (memory) => memory);
  saveWorkStyleGuide.mockImplementation(async (guide) => guide);
});

describe("page context persistence", () => {
  it("does not retain orphan AI IDs when style-guide storage fails", async () => {
    saveWorkStyleGuide.mockRejectedValue(new Error("style disk failure"));
    const styleGuide = makeGuide();
    const workContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide,
      storyMemory: makeMemory(),
      recentPageCount: 6,
    };
    const warnings = createWarningCollector();

    await persistPageContextAfterSuccess({
      page: makePage(),
      pageIndex: 0,
      pageContext: {
        visualSummary: "용사가 문 앞에 선다.",
        glossary: [{ source: "勇者", target: "용사", category: "term" }],
        characters: [],
      },
      collectPageContext: true,
      warningCollector: warnings,
      workContext,
    });

    expect(workContext.styleGuide).toBe(styleGuide);
    expect(workContext.storyMemory.pages[0]).toMatchObject({
      visualSummary: "용사가 문 앞에 선다.",
      glossaryEntryIds: [],
    });
    expect(saveChapterStoryMemory).toHaveBeenCalledOnce();
    expect(warnings.warnings).toEqual([
      expect.stringContaining("용어/캐릭터 기억 저장에 실패했지만"),
    ]);
  });

  it("keeps the approved translation context in memory when page-memory storage fails", async () => {
    saveChapterStoryMemory.mockRejectedValue(new Error("memory disk failure"));
    const workContext = {
      workId: "work-a",
      chapterId: "chapter-a",
      styleGuide: makeGuide(),
      storyMemory: makeMemory(),
      recentPageCount: 6,
    };
    const warnings = createWarningCollector();

    await persistPageContextAfterSuccess({
      page: makePage(),
      pageIndex: 0,
      pageContext: {
        visualSummary: "용사가 문 앞에 선다.",
        glossary: [{ source: "勇者", target: "용사", category: "term" }],
        characters: [],
      },
      collectPageContext: true,
      warningCollector: warnings,
      workContext,
    });

    expect(workContext.styleGuide.glossary).toEqual([
      expect.objectContaining({ source: "勇者", origin: "ai" }),
    ]);
    expect(workContext.storyMemory.pages).toHaveLength(1);
    expect(warnings.warnings).toEqual([
      expect.stringContaining("페이지 기억 저장에 실패했지만"),
    ]);
  });
});

function makeGuide(): WorkStyleGuide {
  return {
    schemaVersion: 1,
    workId: "work-a",
    glossary: [],
    characters: [],
    rules: {
      honorifics: "adapt",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeMemory(): ChapterStoryMemory {
  return {
    schemaVersion: 1,
    workId: "work-a",
    chapterId: "chapter-a",
    pages: [],
    updatedAt: NOW,
  };
}

function makePage(): MangaPage {
  return {
    id: "page-a",
    name: "001.png",
    imagePath: "C:\\images\\001.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [
      {
        id: "block-a",
        type: "nonsolid",
        bbox: { x: 10, y: 10, w: 100, h: 100 },
        sourceText: "勇者",
        translatedText: "용사",
        confidence: 0.95,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 20,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    createdAt: NOW,
    updatedAt: NOW,
  };
}
