import { describe, expect, it } from "vitest";
import type { WorkStyleGuide } from "../src/shared/workContextTypes";
import {
  applyWorkContextResearchOperations,
  createWorkContextResearchFingerprint,
} from "../src/shared/workContextResearchProposal";
import { normalizeWorkContextResearchChanges } from "../src/main/workContextResearchNormalize";

const timestamp = "2026-08-28T00:00:00.000Z";

describe("work context research proposals", () => {
  it("protects manual entries and disables AI entries without deleting them", () => {
    const guide = makeGuide();
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "glossary",
            action: "update",
            entryId: "manual",
            source: "手動語",
            target: "바꾼 값",
            category: "term",
            reason: "web says so",
            confidence: "high",
            sources: [{ title: "Official", url: "https://official.test/work" }],
          },
          {
            entity: "glossary",
            action: "disable",
            entryId: "ai",
            reason: "OCR 오인식이며 로컬 사용도 없다",
            confidence: "high",
            sources: [],
          },
        ],
        warnings: [],
      },
      guide,
      usage: {
        workId: guide.workId,
        glossary: [
          { id: "manual", pageCount: 2, mentionCount: 2 },
          { id: "ai", pageCount: 0, mentionCount: 0 },
        ],
        characters: [],
      },
      selection: makeSelection(),
      allowedSourceUrls: new Set(["https://official.test/work"]),
    });
    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0]).toMatchObject({
      action: "disable",
      after: { id: "ai", enabled: false },
    });
    expect(normalized.warnings.join(" ")).toContain("수동 용어");
    const applied = applyWorkContextResearchOperations(
      guide,
      normalized.operations,
    );
    expect(applied.glossary).toHaveLength(2);
    expect(
      applied.glossary.find((entry) => entry.id === "manual")?.target,
    ).toBe("수동");
    expect(applied.glossary.find((entry) => entry.id === "ai")?.enabled).toBe(
      false,
    );
  });

  it("normalizes duplicate additions into one AI update and keeps allowed sources", () => {
    const guide = makeGuide();
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "ＡＩ 語",
            target: "정식 번역",
            category: "term",
            reason: "공식 표기 확인",
            confidence: "high",
            sources: [
              { title: "Official", url: "https://official.test/work" },
              { title: "Injected", url: "https://untrusted.test/prompt" },
            ],
          },
        ],
        warnings: [],
      },
      guide,
      usage: {
        workId: guide.workId,
        glossary: [{ id: "ai", pageCount: 1, mentionCount: 1 }],
        characters: [],
      },
      selection: makeSelection(),
      allowedSourceUrls: new Set(["https://official.test/work"]),
    });
    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0]).toMatchObject({
      action: "update",
      before: { id: "ai" },
      after: { id: "ai", target: "정식 번역", origin: "ai" },
      selectedByDefault: true,
      sources: [{ title: "Official", url: "https://official.test/work" }],
    });
    expect(
      applyWorkContextResearchOperations(guide, normalized.operations).glossary,
    ).toHaveLength(2);
  });

  it("fingerprints the exact unsaved draft for stale-proposal checks", () => {
    const guide = makeGuide();
    const changed = {
      ...guide,
      glossary: guide.glossary.map((entry) =>
        entry.id === "manual" ? { ...entry, target: "새 수동값" } : entry,
      ),
    };
    expect(createWorkContextResearchFingerprint(changed)).not.toBe(
      createWorkContextResearchFingerprint(guide),
    );
  });

  it("keeps medium-confidence changes unchecked and rejects unsupported additions", () => {
    const guide = makeGuide();
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "開錠（アンロック）",
            target: "개정(언록)",
            category: "term",
            reason: "로컬 OCR과 공식 페이지에서 확인",
            confidence: "medium",
            sources: [
              {
                title: "Official",
                url: "https://official.test/work#characters",
              },
            ],
          },
          {
            entity: "glossary",
            action: "add",
            source: "근거 없음",
            target: "hallucination",
            category: "term",
            reason: "근거가 없다",
            confidence: "high",
            sources: [],
          },
        ],
        warnings: [],
      },
      guide,
      usage: { workId: guide.workId, glossary: [], characters: [] },
      selection: makeSelection(),
      allowedSourceUrls: new Set(["https://official.test/work"]),
    });

    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0]).toMatchObject({
      after: { source: "開錠（アンロック）" },
      selectedByDefault: false,
      sources: [{ url: "https://official.test/work" }],
    });
  });

  it("never updates or disables a manual character", () => {
    const guide = makeGuide();
    guide.characters.push({
      id: "manual-character",
      displayName: "라비",
      sourceNames: ["ラヴィ"],
      targetName: "라비",
      speechStyle: "neutral",
      origin: "manual",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "character",
            action: "disable",
            entryId: "manual-character",
            reason: "잘못된 가지치기",
            confidence: "high",
            sources: [],
          },
        ],
      },
      guide,
      usage: {
        workId: guide.workId,
        glossary: [],
        characters: [{ id: "manual-character", pageCount: 0, mentionCount: 0 }],
      },
      selection: makeSelection(),
    });

    expect(normalized.operations).toEqual([]);
    expect(normalized.warnings.join(" ")).toContain("수동 캐릭터");
  });

  it("deduplicates equivalent character additions by their source name", () => {
    const guide = makeGuide();
    const selection = makeSelection();
    selection.text = 'B1: source="ラヴィ" | ko="라비"';
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["ラヴィ"],
            displayName: "라비",
            targetName: "라비",
            speechStyle: "neutral",
            reason: "공식 등장인물 표기",
            confidence: "high",
            sources: [{ title: "Official", url: "https://official.test/work" }],
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["ラヴィ"],
            displayName: "라뷔",
            targetName: "라뷔",
            speechStyle: "neutral",
            reason: "중복 제안",
            confidence: "high",
            sources: [{ title: "Official", url: "https://official.test/work" }],
          },
        ],
      },
      guide,
      usage: { workId: guide.workId, glossary: [], characters: [] },
      selection,
      allowedSourceUrls: new Set(["https://official.test/work"]),
    });

    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0]).toMatchObject({
      entity: "character",
      after: { sourceNames: ["ラヴィ"], targetName: "라비" },
    });
    expect(normalized.warnings.join(" ")).toContain("중복 제안");
  });

  it("leaves a one-off local-only suggestion unchecked", () => {
    const guide = makeGuide();
    const selection = makeSelection();
    selection.text = 'B1: source="単発迷宮" | ko="단발 미궁"';
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "単発迷宮",
            target: "단발 미궁",
            category: "place",
            reason: "로컬에서 한 번 발견",
            confidence: "high",
            sources: [],
          },
        ],
      },
      guide,
      usage: { workId: guide.workId, glossary: [], characters: [] },
      selection,
    });

    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0]).toMatchObject({
      confidence: "medium",
      selectedByDefault: false,
      evidence: { mentionCount: 1 },
    });
  });

  it("leaves a one-off general term unchecked even when several web pages repeat it", () => {
    const guide = makeGuide();
    const selection = makeSelection();
    selection.text = 'B1: source="一度だけの一般表現" | ko="일반 표현"';
    const urls = [
      "https://publisher.test/work/general-expression",
      "https://reader.test/title/general-expression",
      "https://catalog.test/book/general-expression",
    ];
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "一般表現",
            target: "일반 표현",
            category: "term",
            reason: "여러 웹 페이지의 줄거리 문장에 반복됨",
            confidence: "high",
            sources: urls.map((url, index) => ({
              title: `Source ${index + 1}`,
              url,
            })),
          },
        ],
      },
      guide,
      usage: { workId: guide.workId, glossary: [], characters: [] },
      selection,
      allowedSourceUrls: new Set(urls),
    });

    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0]).toMatchObject({
      confidence: "medium",
      selectedByDefault: false,
      evidence: { mentionCount: 1 },
    });
  });

  it("merges short and full forms of the same character name", () => {
    const guide = makeGuide();
    const selection = makeSelection();
    selection.text = 'B1: source="ロッド・ティングレイ" | ko="로드 팅그레이"';
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["ロッド"],
            displayName: "ロッド",
            targetName: "로드",
            speechStyle: "neutral",
            reason: "주인공의 짧은 이름",
            confidence: "high",
            sources: [{ title: "Official", url: "https://official.test/work" }],
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["ロッド・ティングレイ"],
            displayName: "ロッド・ティングレイ",
            targetName: "로드 팅그레이",
            speechStyle: "neutral",
            reason: "주인공의 전체 이름",
            confidence: "high",
            sources: [],
          },
        ],
      },
      guide,
      usage: { workId: guide.workId, glossary: [], characters: [] },
      selection,
      allowedSourceUrls: new Set(["https://official.test/work"]),
    });

    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0]).toMatchObject({
      entity: "character",
      after: {
        displayName: "로드 팅그레이",
        targetName: "로드 팅그레이",
        sourceNames: ["ロッド・ティングレイ", "ロッド"],
      },
    });
  });

  it("keeps an external-only translation unchecked for human review", () => {
    const guide = makeGuide();
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "glossary",
            action: "add",
            source: "五大迷宮",
            target: "오대 미궁",
            category: "place",
            reason: "공식 페이지에서 발견",
            confidence: "high",
            sources: [{ title: "Official", url: "https://official.test/work" }],
          },
        ],
      },
      guide,
      usage: { workId: guide.workId, glossary: [], characters: [] },
      selection: makeSelection(),
      allowedSourceUrls: new Set(["https://official.test/work"]),
    });

    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0]).toMatchObject({
      confidence: "medium",
      selectedByDefault: false,
      sources: [{ url: "https://official.test/work" }],
      evidence: { mentionCount: 0 },
    });
  });

  it("merges a one-character OCR spelling variant with the same translation", () => {
    const guide = makeGuide();
    const selection = makeSelection();
    selection.text = 'B1: source="ラヴィ ラビ" | ko="라비"';
    const normalized = normalizeWorkContextResearchChanges({
      raw: {
        operations: [
          {
            entity: "character",
            action: "add",
            sourceNames: ["ラヴィ"],
            displayName: "라비",
            targetName: "라비",
            speechStyle: "neutral",
            reason: "공식 표기",
            confidence: "high",
            sources: [{ title: "Official", url: "https://official.test/work" }],
          },
          {
            entity: "character",
            action: "add",
            sourceNames: ["ラビ"],
            displayName: "라비",
            targetName: "라비",
            speechStyle: "neutral",
            reason: "OCR 표기 변형",
            confidence: "high",
            sources: [],
          },
        ],
      },
      guide,
      usage: { workId: guide.workId, glossary: [], characters: [] },
      selection,
      allowedSourceUrls: new Set(["https://official.test/work"]),
    });

    expect(normalized.operations).toHaveLength(1);
    expect(normalized.operations[0]).toMatchObject({
      entity: "character",
      after: {
        displayName: "라비",
        sourceNames: ["ラヴィ", "ラビ"],
        targetName: "라비",
      },
    });
  });
});

function makeGuide(): WorkStyleGuide {
  return {
    schemaVersion: 1,
    workId: "work-1",
    glossary: [
      {
        id: "manual",
        source: "手動語",
        target: "수동",
        category: "term",
        origin: "manual",
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "ai",
        source: "AI語",
        target: "AI 용어",
        category: "term",
        origin: "ai",
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    characters: [],
    rules: {
      honorifics: "preserve",
      sfxMode: "translate",
      defaultTone: "natural_korean",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function makeSelection() {
  return {
    text: "AI語 appears in this local OCR context.",
    basePages: [],
    coverage: {
      scope: "chapter" as const,
      workId: "work-1",
      requestedChapterId: "chapter-1",
      totalChapters: 1,
      includedChapters: 1,
      totalPages: 1,
      includedPages: 1,
      selectedChars: 40,
      maxInputChars: 4_000,
      truncated: false,
    },
  };
}
