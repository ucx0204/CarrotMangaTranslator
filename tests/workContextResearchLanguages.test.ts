import { describe, expect, it } from "vitest";
import { buildTranslatedCriticalEvidenceOperations } from "../src/main/workContextResearchEvidence";
import {
  postprocessWorkContextResearch,
  type WorkContextResearchPostprocessInput,
} from "../src/main/workContextResearchPostprocess";
import {
  buildCodexWebResearchPrompt,
  buildGemmaCriticalCandidateTranslationPrompt,
  buildGemmaResearchAuditPrompt,
  buildGemmaResearchCoverageRepairPrompt,
  buildGemmaResearchSynthesisPrompt,
  buildResearchQueryPlanningPrompt,
  type WorkContextResearchPromptInput,
} from "../src/main/workContextResearchPrompt";
import type { TavilySearchResponse } from "../src/main/tavilyClient";
import { resolveLanguagePair } from "../src/shared/translationLanguages";
import { applyWorkContextResearchOperations } from "../src/shared/workContextResearchProposal";

const timestamp = "2026-09-08T00:00:00.000Z";
const workTitle = "星空を旅する魔法使い";
const characterSource = "エドワード・エルリック";
const glossarySource = "星霊魔術";
const languages = [
  { code: "en", character: "Edward Elric", term: "Star Spirit Magic" },
  { code: "zh-Hans", character: "爱德华·艾尔利克", term: "星灵魔术" },
  { code: "zh-Hant", character: "愛德華·艾爾利克", term: "星靈魔術" },
  { code: "ko", character: "에드워드 엘릭", term: "성령 마술" },
  { code: undefined, character: "에드워드 엘릭", term: "성령 마술" },
];
type LanguageFixture = (typeof languages)[number];

describe("work context research language pairs", () => {
  it.each(languages)(
    "uses the resolved $code target throughout research prompts",
    (language) => {
      const input = makeInput(language);
      const pair = input.languagePair ?? resolveLanguagePair(null);
      const searches = makeSearches();
      const prompts = [
        buildGemmaResearchSynthesisPrompt(input, searches),
        buildGemmaResearchAuditPrompt(input, searches, { operations: [] }),
        buildGemmaResearchCoverageRepairPrompt(
          input,
          searches,
          { operations: [] },
          [characterSource],
        ),
      ];
      for (const prompt of prompts) {
        expect(prompt.systemPrompt).toContain(
          `Target language: ${pair.target.promptName} (${pair.target.code})`,
        );
        expect(prompt.userPrompt).toContain(pair.target.labelKo);
      }
      const codex = buildCodexWebResearchPrompt(input);
      expect(codex.instructions).toContain(
        `Target language: ${pair.target.promptName} (${pair.target.code})`,
      );
      expect(codex.userPrompt).toContain(
        `target, displayName, targetName은 반드시 자연스러운 ${pair.target.labelKo}`,
      );
      const critical = buildGemmaCriticalCandidateTranslationPrompt(
        input,
        searches,
        [characterSource, glossarySource],
      );
      expect(critical.userPrompt).toContain(
        `각 후보를 ${pair.target.labelKo} 번역 또는 음역`,
      );
      expect(buildResearchQueryPlanningPrompt(input, 3).systemPrompt).toContain(
        pair.isDefaultJapaneseToKorean
          ? "일본 만화 번역을 위한 인터넷 조사 검색어 설계자"
          : `${pair.target.labelKo}로 번역`,
      );
      if (pair.target.code !== "ko") {
        expect(
          [
            codex.userPrompt,
            critical.userPrompt,
            ...prompts.map((prompt) => prompt.userPrompt),
          ].join("\n"),
        ).not.toContain("반드시 자연스러운 한국어 번역");
      }
    },
  );

  for (const action of ["add", "update"] as const) {
    it.each(languages)(
      `preserves $code character and glossary ${action} through evidence, normalization, and apply`,
      (language) => {
        const input = makeInput(language, action);
        const original = structuredClone(input.guide);
        const result = postprocessWorkContextResearch(
          makePostprocessInput(input, makeOperations(language, action)),
        );
        expect(result.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              entity: "character",
              action,
              selectedByDefault: true,
              after: expect.objectContaining({
                sourceNames: [characterSource],
                targetName: language.character,
              }),
            }),
            expect.objectContaining({
              entity: "glossary",
              action,
              selectedByDefault: true,
              after: expect.objectContaining({
                source: glossarySource,
                target: language.term,
              }),
            }),
          ]),
        );
        assertAppliedTargets(input, result.operations, language);
        expect(input.guide).toEqual(original);
        if (action === "update") {
          expect(result.operations).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                entity: "character",
                before: expect.objectContaining({ id: "character-existing" }),
                after: expect.objectContaining({ id: "character-existing" }),
              }),
              expect.objectContaining({
                entity: "glossary",
                before: expect.objectContaining({ id: "glossary-existing" }),
                after: expect.objectContaining({ id: "glossary-existing" }),
              }),
            ]),
          );
        }
      },
    );
  }

  it.each(languages)(
    "retains $code critical candidate repairs including a complete middle-dot name",
    (language) => {
      const input = makeInput(language);
      const operations = buildTranslatedCriticalEvidenceOperations(
        [
          { source: characterSource, target: language.character },
          { source: glossarySource, target: language.term },
        ],
        makeSearches(),
        input,
        [characterSource, glossarySource],
      );
      expect(operations).toHaveLength(2);
      const result = postprocessWorkContextResearch(
        makePostprocessInput(input, operations),
      );
      assertAppliedTargets(input, result.operations, language);
    },
  );

  it.each([
    { code: "en", character: "에드워드 엘릭", term: "성령술" },
    { code: "en", character: characterSource, term: glossarySource },
    { code: "zh-Hans", character: "Edward Elric", term: "Star Spirit Arts" },
    { code: "zh-Hans", character: "爱德华・エルリック", term: "星灵じゅつ" },
    { code: "zh-Hant", character: "에드워드 엘릭", term: "성령술" },
    { code: "zh-Hant", character: "愛德華・エルリック", term: "星靈じゅつ" },
    { code: "ko", character: "Edward Elric", term: "Star Spirit Arts" },
    { code: undefined, character: characterSource, term: glossarySource },
  ])(
    "rejects wrong-language targets for $code in normal and critical processing",
    (language) => {
      const input = makeInput(language);
      // No translated local text is available to repair an invalid model result.
      input.selection.text = `${characterSource}は「${glossarySource}」を使う。${characterSource}の能力名は「${glossarySource}」。`;
      const result = postprocessWorkContextResearch(
        makePostprocessInput(input, makeOperations(language, "add")),
      );
      expect(result.operations).toEqual([]);
      expect(
        buildTranslatedCriticalEvidenceOperations(
          [
            { source: characterSource, target: language.character },
            { source: glossarySource, target: language.term },
          ],
          makeSearches(),
          input,
          [characterSource, glossarySource],
        ),
      ).toEqual([]);
    },
  );

  it.each(languages)(
    "does not accept $code translations when sources describe another work",
    (language) => {
      const input = makeInput(language);
      const payload = makePostprocessInput(
        input,
        makeOperations(language, "add"),
      );
      payload.searches = makeSearches().map((search) => ({
        ...search,
        results: search.results.map((result) => ({
          ...result,
          title: "海辺の料理人 公式紹介",
          content: "海辺の料理人の主人公タクミは料理店を営む。",
        })),
      }));
      expect(postprocessWorkContextResearch(payload).operations).toEqual([]);
    },
  );

  it.each(
    languages.filter((language) => language.code && language.code !== "ko"),
  )("does not synthesize Korean fallback names for $code", (language) => {
    const input = makeInput(language);
    input.selection.text = `B1: source="${characterSource}" | target="에드워드 엘릭"\nB2: source="${characterSource}" | target="에드워드 엘릭"`;
    expect(
      postprocessWorkContextResearch(makePostprocessInput(input, []))
        .operations,
    ).toEqual([]);
  });
});

function assertAppliedTargets(
  input: WorkContextResearchPromptInput,
  operations: ReturnType<typeof postprocessWorkContextResearch>["operations"],
  language: LanguageFixture,
) {
  const applied = applyWorkContextResearchOperations(
    input.guide,
    operations.filter((operation) => operation.selectedByDefault),
  );
  expect(applied.characters).toHaveLength(1);
  expect(applied.characters[0]).toMatchObject({
    sourceNames: [characterSource],
    targetName: language.character,
    displayName: language.character,
  });
  expect(applied.glossary).toHaveLength(1);
  expect(applied.glossary[0]).toMatchObject({
    source: glossarySource,
    target: language.term,
  });
}

function makeInput(
  language: LanguageFixture,
  action: "add" | "update" = "add",
): WorkContextResearchPromptInput {
  return {
    workTitle,
    ...(language.code
      ? {
          languagePair: resolveLanguagePair({
            sourceLanguage: "ja",
            targetLanguage: language.code,
          }),
        }
      : {}),
    guide: {
      schemaVersion: 1,
      workId: "work-language-regression",
      glossary:
        action === "update"
          ? [
              {
                id: "glossary-existing",
                source: glossarySource,
                target: "previous term",
                category: "term",
                origin: "ai",
                enabled: true,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ]
          : [],
      characters:
        action === "update"
          ? [
              {
                id: "character-existing",
                sourceNames: [characterSource],
                displayName: "previous name",
                targetName: "previous name",
                speechStyle: "neutral",
                origin: "ai",
                enabled: true,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ]
          : [],
      rules: {
        honorifics: "preserve",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    selection: {
      text: `B1: source="${characterSource}は「${glossarySource}」を使う。" | target="${language.character}: ${language.term}."\nB2: source="${characterSource}の能力名は「${glossarySource}」。" | target="${language.character}: ${language.term}."`,
      basePages: [],
      coverage: {
        scope: "work",
        workId: "work-language-regression",
        requestedChapterId: "chapter-language-regression",
        totalChapters: 1,
        includedChapters: 1,
        totalPages: 2,
        includedPages: 2,
        selectedChars: 200,
        maxInputChars: 65_536,
        truncated: false,
      },
    },
  };
}

function makeOperations(language: LanguageFixture, action: "add" | "update") {
  const sources = makeSearches().flatMap((search) =>
    search.results.map(({ title, url }) => ({ title, url })),
  );
  return [
    {
      entity: "character",
      action,
      entryId: action === "update" ? "character-existing" : null,
      displayName: characterSource,
      sourceNames: [characterSource],
      targetName: language.character,
      speechStyle: "neutral",
      reason: "Character identity is documented in the work's introduction.",
      confidence: "high",
      sources,
    },
    {
      entity: "glossary",
      action,
      entryId: action === "update" ? "glossary-existing" : null,
      source: glossarySource,
      target: language.term,
      category: "term",
      reason: "The work identifies this recurring ability by name.",
      confidence: "high",
      sources,
    },
  ];
}

function makeSearches(): TavilySearchResponse[] {
  return [
    {
      query: `${workTitle} 公式 キャラクター 能力名`,
      credits: 1,
      results: ["publisher", "reader"].map((host) => ({
        title: `${workTitle} 公式作品紹介`,
        url: `https://${host}.example/works/stars`,
        content: `${workTitle}の主人公${characterSource}は旅する魔法使い。${characterSource}の能力名は「${glossarySource}」。${glossarySource}は星の力を操る固有魔法。`,
        score: 0.98,
      })),
    },
  ];
}

function makePostprocessInput(
  input: WorkContextResearchPromptInput,
  operations: unknown[],
): WorkContextResearchPostprocessInput {
  return {
    raw: { operations, warnings: [] },
    searches: makeSearches(),
    promptInput: input,
    usage: { workId: input.guide.workId, glossary: [], characters: [] },
    allowedSourceUrls: makeSearches().flatMap((search) =>
      search.results.map((result) => result.url),
    ),
  };
}
