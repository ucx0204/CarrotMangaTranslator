import { describe, expect, it } from "vitest";
import type { ChapterSnapshot } from "../src/shared/libraryTypes";
import type {
  ChapterStoryMemory,
  WorkStyleGuide,
} from "../src/shared/workContextTypes";
import {
  mergeAiWorkContextSuggestions,
  type BasePageMemory,
} from "../src/main/workContextAiMerge";
import { setMainLocale } from "../src/main/i18n";
import { normalizeAiWorkContextSuggestions } from "../src/main/workContextAiNormalize";
import { selectWorkTextForAnalysis } from "../src/main/workContextAnalysisPrompt";

const now = "2026-01-01T00:00:00.000Z";

describe("AI work context merge", () => {
  it("normalizes AI suggestions and merges glossary, characters, rules, and page memory", () => {
    const guide = makeGuide();
    const memory = makeMemory();
    const suggestions = normalizeAiWorkContextSuggestions({
      glossary: [
        {
          source: "魔王",
          target: "마왕님",
          category: "character",
          aliases: ["魔王様"],
          note: "주요 인물",
          confidence: 0.91,
        },
        {
          source: "黒い塔",
          target: "검은 탑",
          category: "place",
        },
      ],
      characters: [
        {
          displayName: "마왕",
          sourceNames: ["魔王"],
          targetName: "마왕님",
          speechStyle: "rough",
          note: "명령조",
        },
      ],
      rules: { honorifics: "preserve", sfxMode: "translate" },
      page_summaries: [
        {
          chapter_id: "chapter-a",
          page_id: "page-a",
          summary: "마왕이 검은 탑을 언급한다.",
          character_names: ["마왕"],
        },
      ],
    });

    const result = mergeAiWorkContextSuggestions({
      styleGuide: guide,
      memories: [memory],
      basePages: [makeBasePage()],
      suggestions,
      now,
    });

    expect(result.counts.glossaryUpdated).toBe(1);
    expect(result.counts.glossaryAdded).toBe(1);
    expect(result.counts.charactersAdded).toBe(1);
    expect(result.counts.rulesUpdated).toBe(1);
    expect(result.counts.pageSummariesUpserted).toBe(1);
    expect(result.styleGuide.glossary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "魔王",
          target: "마왕님",
          aliases: ["魔王様"],
        }),
        expect.objectContaining({ source: "黒い塔", target: "검은 탑" }),
      ]),
    );
    expect(result.styleGuide.characters[0]).toEqual(
      expect.objectContaining({
        displayName: "마왕",
        sourceNames: ["魔王"],
        targetName: "마왕님",
        speechStyle: "rough",
      }),
    );
    expect(result.styleGuide.glossary[0].note).toBe("주요 인물");
    expect(result.styleGuide.glossary[0].note).not.toContain("AI confidence");
    expect(result.styleGuide.characters[0].note).toBe("명령조");
    expect(result.memories[0].pages[0]).toEqual(
      expect.objectContaining({
        pageId: "page-a",
        summary: "마왕이 검은 탑을 언급한다.",
        characterIds: [result.styleGuide.characters[0].id],
      }),
    );
    expect("workId" in result.memories[0].pages[0]).toBe(false);
    expect("chapterId" in result.memories[0].pages[0]).toBe(false);
  });

  it("keeps the requested chapter in the selected work text when the work is truncated", () => {
    const chapters = [
      makeChapter("chapter-a", "1화"),
      makeChapter("chapter-b", "2화"),
    ];
    const selection = selectWorkTextForAnalysis({
      workId: "work-a",
      requestedChapterId: "chapter-b",
      chapters,
      scope: "work",
      maxInputChars: 1500,
    });

    expect(selection.coverage.truncated).toBe(true);
    expect(
      selection.basePages.some((page) => page.chapterId === "chapter-b"),
    ).toBe(true);
  });

  it("selects only the requested chapter in chapter-scope analysis", () => {
    const chapters = [
      makeChapter("chapter-a", "1화"),
      makeChapter("chapter-b", "2화"),
    ];
    const selection = selectWorkTextForAnalysis({
      workId: "work-a",
      requestedChapterId: "chapter-b",
      chapters,
      scope: "chapter",
      maxInputChars: 12000,
    });

    expect(selection.coverage.scope).toBe("chapter");
    expect(selection.coverage.truncated).toBe(false);
    expect(
      selection.basePages.every((page) => page.chapterId === "chapter-b"),
    ).toBe(true);
  });

  it("localizes warnings for unknown AI page identifiers", () => {
    setMainLocale("en");
    try {
      const result = mergeAiWorkContextSuggestions({
        styleGuide: makeGuide(),
        memories: [makeMemory()],
        basePages: [makeBasePage()],
        suggestions: normalizeAiWorkContextSuggestions({
          page_summaries: [
            {
              chapter_id: "chapter-a",
              page_id: "unknown-page",
              summary: "ignored",
            },
          ],
        }),
        now,
      });
      expect(result.warnings).toContain(
        "AI returned an unknown pageId: unknown-page",
      );
    } finally {
      setMainLocale("ko");
    }
  });
});

function makeGuide(): WorkStyleGuide {
  return {
    schemaVersion: 1,
    workId: "work-a",
    glossary: [
      {
        id: "glossary-a",
        source: "魔王",
        target: "마왕",
        category: "term",
        aliases: [],
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    characters: [],
    rules: {
      honorifics: "adapt",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function makeMemory(): ChapterStoryMemory {
  return {
    schemaVersion: 1,
    workId: "work-a",
    chapterId: "chapter-a",
    pages: [],
    updatedAt: now,
  };
}

function makeBasePage(): BasePageMemory {
  return {
    workId: "work-a",
    chapterId: "chapter-a",
    pageId: "page-a",
    pageName: "001.png",
    pageIndex: 0,
    sourceDigest: "魔王 黒い塔",
    translatedDigest: "마왕 검은 탑",
    summary: "마왕 검은 탑",
    updatedAt: now,
  };
}

function makeChapter(id: string, title: string): ChapterSnapshot {
  return {
    id,
    workId: "work-a",
    title,
    sourceKind: "folder",
    status: "completed",
    pageOrder: ["page-1", "page-2", "page-3"],
    pages: ["page-1", "page-2", "page-3"].map((pageId, index) =>
      makePage(`${id}-${pageId}`, index),
    ),
    createdAt: now,
    updatedAt: now,
  };
}

function makePage(id: string, index: number): ChapterSnapshot["pages"][number] {
  return {
    id,
    name: `${index + 1}.png`,
    imagePath: `C:\\library\\${id}.png`,
    dataUrl: "",
    width: 100,
    height: 100,
    blocks: [
      {
        id: `block-${id}`,
        type: "nonsolid",
        bbox: { x: 1, y: 1, w: 10, h: 10 },
        sourceText: "長い原文".repeat(120),
        translatedText: "긴 번역".repeat(120),
        confidence: 0.9,
        sourceDirection: "vertical",
        renderDirection: "horizontal",
        fontSizePx: 16,
        lineHeight: 1.2,
        textAlign: "center",
        textColor: "#111111",
        backgroundColor: "#ffffff",
        opacity: 1,
      },
    ],
    analysisStatus: "completed",
    createdAt: now,
    updatedAt: now,
  };
}
