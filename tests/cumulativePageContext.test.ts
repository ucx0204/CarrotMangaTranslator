import { describe, expect, it } from "vitest";
import type { MangaPage } from "../src/shared/libraryTypes";
import type {
  PageStoryMemory,
  WorkStyleGuide,
} from "../src/shared/workContextTypes";
import { mergeCumulativePageContext } from "../src/main/pipeline/cumulativePageContext";

describe("cumulative page context merge", () => {
  it("adds only grounded new entries and never overwrites existing values", () => {
    const guide = makeGuide();
    const existingMemory = makeExistingMemory();
    const result = mergeCumulativePageContext({
      styleGuide: guide,
      existingPageMemory: existingMemory,
      page: makePage(),
      pageIndex: 4,
      pageContext: {
        visualSummary: "AI가 새로 만든 요약",
        glossary: [
          {
            source: "魔王",
            target: "마왕님으로 덮어쓰기",
            category: "character",
          },
          {
            source: "勇者",
            target: "용사",
            category: "term",
          },
          {
            source: "王国",
            target: "왕국",
            category: "place",
          },
        ],
        characters: [
          {
            displayName: "아리아",
            sourceNames: ["アリア"],
            targetName: "아리아",
            speechStyle: "polite",
          },
          {
            displayName: "보이지 않는 사람",
            sourceNames: ["見えない人"],
            targetName: "보이지 않는 사람",
          },
        ],
      },
      now: "2026-07-15T00:00:00.000Z",
    });

    expect(result.guideChanged).toBe(true);
    expect(result.styleGuide.glossary).toHaveLength(2);
    expect(result.styleGuide.glossary[0]).toMatchObject({
      source: "魔王",
      target: "마왕",
      origin: "manual",
    });
    expect(result.styleGuide.glossary[1]).toMatchObject({
      source: "勇者",
      target: "용사",
      origin: "ai",
    });
    expect(result.styleGuide.characters).toHaveLength(1);
    expect(result.styleGuide.characters[0]).toMatchObject({
      displayName: "아리아",
      targetName: "아리아",
      origin: "ai",
    });
    expect(result.pageMemory.visualSummary).toBe("사용자가 쓴 장면 요약");
    expect(result.pageMemory.visualSummarySource).toBe("manual");
    expect(result.pageMemory.glossaryEntryIds).toEqual(
      expect.arrayContaining([
        "glossary-existing",
        result.styleGuide.glossary[1]?.id,
      ]),
    );
    expect(result.pageMemory.characterIds).toEqual([
      result.styleGuide.characters[0]?.id,
    ]);
  });

  it("replaces the page snapshot instead of carrying stale usage ids", () => {
    const result = mergeCumulativePageContext({
      styleGuide: makeGuide(),
      existingPageMemory: {
        ...makeExistingMemory(),
        visualSummarySource: "ai",
        glossaryEntryIds: ["stale-id"],
        characterIds: ["stale-character"],
      },
      page: makePage({ sourceText: "こんにちは", translatedText: "안녕" }),
      pageIndex: 4,
      pageContext: {
        visualSummary: "두 인물이 인사한다.",
        glossary: [],
        characters: [],
      },
    });

    expect(result.pageMemory.visualSummary).toBe("두 인물이 인사한다.");
    expect(result.pageMemory.glossaryEntryIds).toEqual([]);
    expect(result.pageMemory.characterIds).toEqual([]);
  });

  it("treats an existing visual summary without source metadata as protected", () => {
    const existing = makeExistingMemory();
    delete existing.visualSummarySource;
    const result = mergeCumulativePageContext({
      styleGuide: makeGuide(),
      existingPageMemory: existing,
      page: makePage(),
      pageIndex: 4,
      pageContext: {
        visualSummary: "새 AI 요약",
        glossary: [],
        characters: [],
      },
    });

    expect(result.pageMemory.visualSummary).toBe("사용자가 쓴 장면 요약");
    expect(result.pageMemory.visualSummarySource).toBe("manual");
  });

  it("caps per-page evidence snapshots at the storage schema limit", () => {
    const guide = makeGuide();
    guide.glossary = Array.from({ length: 101 }, (_, index) => ({
      ...guide.glossary[0],
      id: `glossary-${index}`,
      source: `術語${index}`,
      target: `용어${index}`,
    }));
    guide.characters = Array.from({ length: 101 }, (_, index) => ({
      id: `character-${index}`,
      displayName: `인물${index}`,
      sourceNames: [`人物${index}`],
      targetName: `인물${index}`,
      speechStyle: "neutral" as const,
      enabled: true,
      createdAt: guide.createdAt,
      updatedAt: guide.updatedAt,
    }));
    const page = makePage({
      sourceText: [
        ...guide.glossary.map((entry) => entry.source),
        ...guide.characters.flatMap((entry) => entry.sourceNames),
      ].join(" "),
      translatedText: "번역",
    });

    const result = mergeCumulativePageContext({
      styleGuide: guide,
      page,
      pageIndex: 4,
    });

    expect(result.pageMemory.glossaryEntryIds).toHaveLength(100);
    expect(result.pageMemory.characterIds).toHaveLength(100);
  });

  it("does not infer usage for unrelated entries that share a translated value", () => {
    const guide = makeGuide();
    guide.glossary = [
      { ...guide.glossary[0], id: "first", source: "我", target: "나" },
      { ...guide.glossary[0], id: "second", source: "余", target: "나" },
    ];
    const result = mergeCumulativePageContext({
      styleGuide: guide,
      page: makePage({ sourceText: "我が行く", translatedText: "내가 간다" }),
      pageIndex: 4,
    });

    expect(result.pageMemory.glossaryEntryIds).toEqual(["first"]);
  });

  it("rejects exact name collisions across glossary and character collections", () => {
    const guide = makeGuide();
    guide.characters.push({
      id: "character-existing",
      displayName: "아리아",
      sourceNames: ["アリア"],
      targetName: "아리아",
      speechStyle: "neutral",
      enabled: true,
      createdAt: guide.createdAt,
      updatedAt: guide.updatedAt,
    });
    const result = mergeCumulativePageContext({
      styleGuide: guide,
      page: makePage(),
      pageIndex: 4,
      pageContext: {
        visualSummary: "세 인물이 대화한다.",
        glossary: [
          {
            source: "アリア",
            target: "아리아",
            category: "character",
          },
        ],
        characters: [
          {
            displayName: "마왕",
            sourceNames: ["魔王"],
            targetName: "마왕",
          },
        ],
      },
    });

    expect(result.styleGuide.glossary).toHaveLength(1);
    expect(result.styleGuide.characters).toHaveLength(1);
    expect(result.guideChanged).toBe(false);
  });

  it("does not ground a term by joining separate source or translation blocks", () => {
    const page = makePage();
    const template = page.blocks[0];
    if (!template) throw new Error("test block missing");
    page.blocks = [
      {
        ...template,
        id: "block-left",
        sourceText: "勇",
        translatedText: "용",
      },
      {
        ...template,
        id: "block-right",
        sourceText: "者",
        translatedText: "사",
      },
    ];

    const result = mergeCumulativePageContext({
      styleGuide: makeGuide(),
      page,
      pageIndex: 0,
      pageContext: {
        glossary: [{ source: "勇者", target: "용사", category: "term" }],
        characters: [],
      },
    });

    expect(result.guideChanged).toBe(false);
    expect(result.styleGuide.glossary).toHaveLength(1);
  });

  it("stores only individually grounded aliases and character names", () => {
    const page = makePage({
      sourceText: "勇者と英雄、アリア姫",
      translatedText: "용사와 아리아",
    });
    const result = mergeCumulativePageContext({
      styleGuide: makeGuide(),
      page,
      pageIndex: 0,
      pageContext: {
        glossary: [
          {
            source: "勇者",
            target: "용사",
            category: "term",
            aliases: ["英雄", "완전한환각"],
          },
        ],
        characters: [
          {
            displayName: "근거 없는 표시 이름",
            sourceNames: ["アリア", "幻名"],
            targetName: "아리아",
            aliases: ["姫", "환각별칭"],
          },
        ],
      },
    });

    expect(result.styleGuide.glossary[1]).toMatchObject({
      source: "勇者",
      target: "용사",
      aliases: ["英雄"],
    });
    expect(result.styleGuide.characters[0]).toMatchObject({
      displayName: "아리아",
      sourceNames: ["アリア"],
      targetName: "아리아",
      aliases: ["姫"],
    });
  });
});

function makeGuide(): WorkStyleGuide {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    schemaVersion: 1,
    workId: "work-a",
    glossary: [
      {
        id: "glossary-existing",
        source: "魔王",
        target: "마왕",
        category: "character",
        origin: "manual",
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

function makeExistingMemory(): PageStoryMemory {
  return {
    pageId: "page-a",
    pageName: "005.png",
    pageIndex: 4,
    sourceDigest: "old",
    translatedDigest: "old",
    summary: "old",
    visualSummary: "사용자가 쓴 장면 요약",
    visualSummarySource: "manual",
    glossaryEntryIds: ["stale-id"],
    characterIds: ["stale-character"],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makePage(
  text: { sourceText: string; translatedText: string } = {
    sourceText: "魔王と勇者、アリア",
    translatedText: "마왕과 용사, 아리아",
  },
): MangaPage {
  return {
    id: "page-a",
    name: "005.png",
    imagePath: "C:\\images\\005.png",
    dataUrl: "",
    width: 1000,
    height: 1400,
    blocks: [
      {
        id: "block-a",
        type: "nonsolid",
        bbox: { x: 10, y: 10, w: 100, h: 100 },
        sourceText: text.sourceText,
        translatedText: text.translatedText,
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
