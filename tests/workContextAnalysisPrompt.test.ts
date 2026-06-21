import { describe, expect, it } from "vitest";
import {
  buildWorkContextAnalysisPrompt,
  type WorkTextSelection,
} from "../src/main/workContextAnalysisPrompt";
import type { WorkStyleGuide } from "../src/shared/types";

describe("AI work context analysis prompt", () => {
  it("asks for glossary and characters from every included chapter", () => {
    const prompt = buildWorkContextAnalysisPrompt({
      guide: makeGuide(),
      selection: makeSelection(),
    });

    expect(prompt.userPrompt).toContain(
      "glossary와 characters는 포함된 모든 화에서 추출하라",
    );
    expect(prompt.userPrompt).toContain(
      "한 번만 등장해도 고유명사이거나 세계관 용어이면 포함하라",
    );
    expect(prompt.userPrompt).toContain(
      "pageSummaries는 requestedChapterId=chapter-b",
    );
    expect(prompt.userPrompt).toContain(
      "출력이 길어질 것 같으면 pageSummaries보다 glossary와 characters를 우선하라",
    );
    expect(prompt.userPrompt).toContain("AI confidence, confidence 1.00");
    expect(prompt.userPrompt).not.toContain('"confidence"');
    expect(prompt.userPrompt).not.toContain("confidence: 0.9");
  });
});

function makeGuide(): WorkStyleGuide {
  const now = "2026-01-01T00:00:00.000Z";
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
    createdAt: now,
    updatedAt: now,
  };
}

function makeSelection(): WorkTextSelection {
  return {
    text: [
      "CHAPTER 1: 1화",
      "chapterId=chapter-a",
      "PAGE 1: 001.png",
      "pageId=page-a",
      'B1: source="ステイシー様" | ko="스테이시 님"',
      "",
      "CHAPTER 2: 2화",
      "chapterId=chapter-b",
      "PAGE 1: 001.png",
      "pageId=page-b",
      'B1: source="レオン君" | ko="레온 군"',
    ].join("\n"),
    basePages: [],
    coverage: {
      scope: "work",
      workId: "work-a",
      requestedChapterId: "chapter-b",
      totalChapters: 2,
      includedChapters: 2,
      totalPages: 2,
      includedPages: 2,
      selectedChars: 120,
      maxInputChars: 12000,
      truncated: false,
    },
  };
}
