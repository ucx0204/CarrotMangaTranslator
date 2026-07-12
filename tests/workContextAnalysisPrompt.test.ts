import { describe, expect, it } from "vitest";
import {
  buildWorkContextAnalysisPrompt,
  type WorkTextSelection,
} from "../src/main/workContextAnalysisPrompt";
import { resolveLanguagePair } from "../src/shared/translationLanguages";
import type { WorkStyleGuide } from "../src/shared/workContextTypes";

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

  it("keeps the Japanese -> Korean wording for the default language pair", () => {
    const prompt = buildWorkContextAnalysisPrompt({
      guide: makeGuide(),
      selection: makeSelection(),
      languagePair: resolveLanguagePair({
        sourceLanguage: "ja",
        targetLanguage: "ko",
      }),
    });

    expect(prompt.systemPrompt).toContain(
      "일본어/원문과 기존 한국어 번역을 함께 읽고",
    );
    expect(prompt.userPrompt).toContain(
      "아래 작품 텍스트를 분석해서 한국어 번역용 작품 메모리를 만들어라.",
    );
    expect(prompt.userPrompt).toContain("様/君/さん/ちゃん/先生/王/神");
    expect(prompt.userPrompt).toContain("한국어 확정 번역");
  });

  it("writes language-neutral instructions for other language pairs", () => {
    const prompt = buildWorkContextAnalysisPrompt({
      guide: makeGuide(),
      selection: makeSelection(),
      languagePair: resolveLanguagePair({
        sourceLanguage: "en",
        targetLanguage: "fr",
      }),
    });

    expect(prompt.systemPrompt).toContain(
      "원문(영어)과 기존 번역(프랑스어)을 함께 읽고",
    );
    expect(prompt.userPrompt).toContain(
      "아래 작품 텍스트를 분석해서 프랑스어 번역용 작품 메모리를 만들어라.",
    );
    expect(prompt.userPrompt).not.toContain("様/君/さん");
    expect(prompt.userPrompt).not.toContain("한국어 확정 번역");
    expect(prompt.userPrompt).toContain("프랑스어 확정 번역");
    expect(prompt.userPrompt).toContain(
      "다른 번역 언어로 작성됐을 수 있으므로",
    );
    expect(prompt.userPrompt).toContain("자연스러운 번역 언어 문체를 뜻한다");
    // 저장 호환을 위해 defaultTone enum 값은 그대로 유지된다.
    expect(prompt.userPrompt).toContain(
      "rules.defaultTone = natural_korean | literal",
    );
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
