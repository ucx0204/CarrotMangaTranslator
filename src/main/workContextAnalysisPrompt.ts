import type { ChapterSnapshot, MangaPage } from "../shared/libraryTypes";
import type {
  WorkContextAnalysisScope,
  WorkContextAnalysisCoverage,
} from "../shared/workContextAnalysisTypes";
import type { WorkStyleGuide } from "../shared/workContextTypes";
import {
  resolveLanguagePair,
  type ResolvedLanguagePair,
} from "../shared/translationLanguages";
import { buildPageStoryMemory } from "./pipeline/storyMemoryBuilder";
import type { BasePageMemory } from "./workContextAiTypes";
import {
  selectPriorityTextItemIndexes,
  spreadItemIndexes,
} from "./workContextResearchTextSelection";

export type WorkTextSelection = {
  text: string;
  basePages: BasePageMemory[];
  coverage: WorkContextAnalysisCoverage;
};

type WorkTextPage = {
  workId: string;
  chapterId: string;
  chapterTitle: string;
  chapterIndex: number;
  page: MangaPage;
  pageIndex: number;
  section: string;
};

const MAX_PAGE_SECTION_CHARS = 2200;
const MAX_BLOCK_TEXT_CHARS = 260;
const MAX_REPAIR_OUTPUT_CHARS = 32000;

export function selectWorkTextForAnalysis({
  workId,
  requestedChapterId,
  chapters,
  scope,
  maxInputChars,
  languagePair,
  priorityTerms = [],
  spreadAcrossWork = false,
}: {
  workId: string;
  requestedChapterId: string;
  chapters: ChapterSnapshot[];
  scope: WorkContextAnalysisScope;
  maxInputChars: number;
  languagePair?: ResolvedLanguagePair;
  priorityTerms?: readonly string[];
  spreadAcrossWork?: boolean;
}): WorkTextSelection {
  const pair = languagePair ?? resolveLanguagePair(null);
  const pages = chapters.flatMap((chapter, chapterIndex) =>
    chapter.pages.map((page, pageIndex) =>
      makeWorkTextPage(chapter, chapterIndex, page, pageIndex, pair),
    ),
  );
  const candidatePages =
    scope === "chapter"
      ? pages.filter((page) => page.chapterId === requestedChapterId)
      : pages;
  const textPages = candidatePages.filter((page) => page.section.trim());
  const selected = selectPagesWithinBudget(
    textPages,
    requestedChapterId,
    maxInputChars,
    priorityTerms,
    spreadAcrossWork,
  );
  const ordered = selected.sort(compareWorkTextPages);
  return {
    text: ordered.map((page) => page.section).join("\n\n"),
    basePages: ordered.map((page) => makeBasePageMemory(page)),
    coverage: {
      scope,
      workId,
      requestedChapterId,
      totalChapters: chapters.length,
      includedChapters: new Set(ordered.map((page) => page.chapterId)).size,
      totalPages: candidatePages.length,
      includedPages: ordered.length,
      selectedChars: ordered.reduce(
        (sum, page) => sum + page.section.length,
        0,
      ),
      maxInputChars,
      truncated: ordered.length < textPages.length,
    },
  };
}

export function buildWorkContextAnalysisPrompt({
  guide,
  selection,
  languagePair,
}: {
  guide: WorkStyleGuide;
  selection: WorkTextSelection;
  languagePair?: ResolvedLanguagePair;
}): { systemPrompt: string; userPrompt: string } {
  const pair = languagePair ?? resolveLanguagePair(null);
  const isDefault = pair.isDefaultJapaneseToKorean;
  const targetLabel = pair.target.labelKo;
  return {
    systemPrompt: [
      "너는 만화 번역 프로젝트의 작품 메모리 편집자다.",
      isDefault
        ? "일본어/원문과 기존 한국어 번역을 함께 읽고, 번역 일관성을 높일 용어집, 캐릭터 이름/말투, 스토리 메모리를 구조화한다."
        : `원문(${pair.source.labelKo})과 기존 번역(${targetLabel})을 함께 읽고, 번역 일관성을 높일 용어집, 캐릭터 이름/말투, 스토리 메모리를 구조화한다.`,
      "추측이 약한 항목은 제외하고, 출력은 설명 없이 JSON 객체 하나만 반환한다.",
    ].join("\n"),
    userPrompt: [
      isDefault
        ? "아래 작품 텍스트를 분석해서 한국어 번역용 작품 메모리를 만들어라."
        : `아래 작품 텍스트를 분석해서 ${targetLabel} 번역용 작품 메모리를 만들어라.`,
      "",
      "반드시 이 JSON 스키마로만 답해라:",
      makeOutputSchemaText(pair),
      "",
      "분류 enum:",
      "glossary.category = character | alias | place | term | sfx | honorific | other",
      "characters.speechStyle = neutral | polite | casual | rough | childish | elderly | formal | custom",
      "rules.honorifics = preserve | adapt | drop",
      "rules.sfxMode = preserve | translate | note",
      "rules.defaultTone = natural_korean | literal",
      ...(!isDefault
        ? [
            "- natural_korean은 저장 호환용 이름이며, 이 언어쌍에서는 자연스러운 번역 언어 문체를 뜻한다.",
          ]
        : []),
      "",
      "작성 기준:",
      `- glossary와 characters는 ${formatExtractionScope(selection.coverage.scope)}에서 추출하라.`,
      "- 이 분석은 여러 화를 반복 실행해 작품 용어집과 캐릭터 메모리에 계속 병합되는 흐름이다.",
      "- pageSummaries만 requestedChapterId와 같은 화로 제한하라.",
      isDefault
        ? "- source는 원문에 등장한 표기를 그대로 적고, target은 기존 ko 번역 표기가 있으면 그 표기를 우선 사용하라."
        : "- source는 원문에 등장한 표기를 그대로 적어라. 기존 작품 메모리의 target은 다른 번역 언어로 작성됐을 수 있으므로, 현재 번역 언어 표기일 때만 우선하고 아니면 현재 번역 언어로 새로 번역하라.",
      "- 인명, 별명, 호칭, 장소명, 조직명, 왕국명, 학교명, 연구회명, 마법/속성/아이템/신물처럼 이후 번역 통일에 필요한 항목을 적극적으로 담아라.",
      "- 한 번만 등장해도 고유명사이거나 세계관 용어이면 포함하라. 단순 일반명사만 제외하라.",
      isDefault
        ? "- 원문 이름에 様/君/さん/ちゃん/先生/王/神이 붙거나, 한국어가 ~님/선생님/왕/여신으로 번역된 개별 인물·신격은 characters 후보로 우선 등록하라."
        : "- 원문 이름에 존칭·경칭이 붙거나 번역에서 존칭으로 옮겨진 개별 인물·신격은 characters 후보로 우선 등록하라.",
      isDefault
        ? "- 캐릭터는 같은 인물의 원문 이름/별명/한국어 이름/말투를 묶고, 말투를 모르겠으면 neutral로 두어라."
        : "- 캐릭터는 같은 인물의 원문 이름/별명/번역 이름/말투를 묶고, 말투를 모르겠으면 neutral로 두어라.",
      "- note에는 번역에 도움이 되는 역할, 관계, 말투, 의미 설명만 짧게 적어라.",
      "- note, target, aliases, displayName, targetName 안에 Page 11, 11쪽, pageId, chapterId, AI confidence, confidence 1.00, 확신도, 출처, 근거 페이지 같은 분석 메타데이터를 절대 쓰지 마라.",
      "- 신뢰도 숫자는 어떤 필드에도 쓰지 마라. 확실하지 않은 항목은 confidence를 낮추는 대신 아예 제외하라.",
      "- 충분한 입력이 있으면 glossary 20~80개, characters 5~50개를 목표로 하라. 허위 생성은 금지한다.",
      "- glossary는 최대 80개, characters는 최대 50개만 반환하라.",
      `- pageSummaries는 requestedChapterId=${selection.coverage.requestedChapterId}인 쪽만 반환하고 최대 80개로 제한하라.`,
      "- 출력이 길어질 것 같으면 pageSummaries보다 glossary와 characters를 우선하라.",
      "- 원문/기존 번역에서 근거를 찾을 수 없는 항목은 넣지 마라. 분류만 애매하면 term 또는 other로 두어라.",
      "",
      `분석 모드: ${selection.coverage.scope}`,
      `분석 범위: ${selection.coverage.includedChapters}/${selection.coverage.totalChapters}화, ${selection.coverage.includedPages}/${selection.coverage.totalPages}쪽`,
      `requestedChapterId: ${selection.coverage.requestedChapterId}`,
      `truncated: ${selection.coverage.truncated ? "true" : "false"}`,
      "",
      isDefault
        ? "기존 작품 메모리:"
        : "기존 작품 메모리(다른 언어쌍 데이터일 수 있으므로 의미와 항목 식별 힌트로만 사용):",
      summarizeExistingGuide(guide),
      "",
      "작품 텍스트:",
      selection.text || "(분석할 텍스트 없음)",
    ].join("\n"),
  };
}

function formatExtractionScope(scope: WorkContextAnalysisScope): string {
  return scope === "work" ? "포함된 모든 화" : "현재 화";
}

export function buildWorkContextJsonRepairPrompt(
  rawText: string,
  languagePair?: ResolvedLanguagePair,
): {
  systemPrompt: string;
  userPrompt: string;
} {
  return {
    systemPrompt: [
      "너는 깨진 JSON을 고치는 데이터 정리기다.",
      "새 항목을 만들지 말고, 제공된 내용에서 확실히 복구 가능한 항목만 남겨라.",
      "출력은 설명 없이 유효한 JSON 객체 하나만 반환한다.",
    ].join("\n"),
    userPrompt: [
      "아래 AI 작품 메모리 분석 응답을 유효한 JSON으로 고쳐라.",
      "문자열 따옴표/이스케이프/후행 콤마/잘린 항목을 정리하되, 불완전한 항목은 삭제하라.",
      "",
      "반드시 이 JSON 스키마로만 답해라:",
      makeOutputSchemaText(languagePair ?? resolveLanguagePair(null)),
      "",
      "깨진 응답:",
      capText(rawText, MAX_REPAIR_OUTPUT_CHARS),
    ].join("\n"),
  };
}

function selectPagesWithinBudget(
  pages: WorkTextPage[],
  requestedChapterId: string,
  maxInputChars: number,
  priorityTerms: readonly string[] = [],
  spreadAcrossWork = false,
): WorkTextPage[] {
  if (measurePages(pages) <= maxInputChars) {
    return pages;
  }
  const selected = new Map<string, WorkTextPage>();
  if (priorityTerms.length > 0) {
    addPagesToSelection(
      selected,
      selectPagesByIndexes(
        pages,
        selectPriorityTextItemIndexes(
          pages.map((page) => page.section),
          priorityTerms,
        ),
      ),
      Math.floor(maxInputChars * 0.72),
    );
  }
  if (!spreadAcrossWork) {
    const currentBudget = Math.max(
      measurePages([...selected.values()]),
      Math.floor(maxInputChars * 0.35),
    );
    addPagesToSelection(
      selected,
      pages.filter((page) => page.chapterId === requestedChapterId),
      currentBudget,
    );
  }
  addPagesToSelection(
    selected,
    spreadAcrossWork
      ? selectPagesByIndexes(pages, spreadItemIndexes(pages.length))
      : pages,
    maxInputChars,
  );
  return Array.from(selected.values());
}

function selectPagesByIndexes(
  pages: readonly WorkTextPage[],
  indexes: readonly number[],
): WorkTextPage[] {
  return indexes.flatMap((index) => {
    const page = pages[index];
    return page ? [page] : [];
  });
}

function addPagesToSelection(
  selected: Map<string, WorkTextPage>,
  pages: WorkTextPage[],
  maxChars: number,
): void {
  for (const page of pages) {
    if (selected.has(page.page.id)) {
      continue;
    }
    const nextSize = measurePages([...selected.values(), page]);
    if (nextSize > maxChars && selected.size > 0) {
      continue;
    }
    selected.set(page.page.id, page);
  }
}

function makeWorkTextPage(
  chapter: ChapterSnapshot,
  chapterIndex: number,
  page: MangaPage,
  pageIndex: number,
  languagePair: ResolvedLanguagePair,
): WorkTextPage {
  const blockLines = page.blocks
    .map((block, blockIndex) =>
      formatBlockLine(blockIndex, block, languagePair),
    )
    .filter(Boolean);
  const header = [
    `CHAPTER ${chapterIndex + 1}: ${chapter.title}`,
    `chapterId=${chapter.id}`,
    `PAGE ${pageIndex + 1}: ${page.name}`,
    `pageId=${page.id}`,
  ].join("\n");
  const body = capText(blockLines.join("\n"), MAX_PAGE_SECTION_CHARS);
  return {
    workId: chapter.workId,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    chapterIndex,
    page,
    pageIndex,
    section: body ? `${header}\n${body}` : "",
  };
}

function formatBlockLine(
  blockIndex: number,
  block: MangaPage["blocks"][number],
  languagePair: ResolvedLanguagePair,
): string {
  const source = capText(block.sourceText, MAX_BLOCK_TEXT_CHARS);
  const translated = capText(block.translatedText, MAX_BLOCK_TEXT_CHARS);
  if (!source && !translated) {
    return "";
  }
  // ja→ko 기본에서는 기존 프롬프트와 동일하게 ko= 라벨을 유지한다.
  const targetLabel = languagePair.isDefaultJapaneseToKorean ? "ko" : "target";
  return `B${blockIndex + 1}: source="${source}" | ${targetLabel}="${translated}"`;
}

function makeBasePageMemory(page: WorkTextPage): BasePageMemory {
  return {
    ...buildPageStoryMemory({
      page: page.page,
      pageIndex: page.pageIndex,
    }),
    workId: page.workId,
    chapterId: page.chapterId,
  };
}

function compareWorkTextPages(left: WorkTextPage, right: WorkTextPage): number {
  return (
    left.chapterIndex - right.chapterIndex || left.pageIndex - right.pageIndex
  );
}

function measurePages(pages: WorkTextPage[]): number {
  return pages.reduce((sum, page) => sum + page.section.length + 2, 0);
}

function summarizeExistingGuide(guide: WorkStyleGuide): string {
  return JSON.stringify({
    rules: guide.rules,
    glossary: guide.glossary.slice(0, 120).map((entry) => ({
      source: entry.source,
      target: entry.target,
      category: entry.category,
      aliases: entry.aliases,
      note: entry.note,
    })),
    characters: guide.characters.slice(0, 80).map((character) => ({
      displayName: character.displayName,
      sourceNames: character.sourceNames,
      targetName: character.targetName,
      aliases: character.aliases,
      speechStyle: character.speechStyle,
      customSpeechStyle: character.customSpeechStyle,
      note: character.note,
    })),
  });
}

function makeOutputSchemaText(pair: ResolvedLanguagePair): string {
  const isDefault = pair.isDefaultJapaneseToKorean;
  const targetLabel = pair.target.labelKo;
  return JSON.stringify(
    {
      glossary: [
        {
          source: isDefault ? "原文表記" : "원문 표기",
          target: isDefault ? "한국어 확정 번역" : `${targetLabel} 확정 번역`,
          category: "character",
          aliases: ["다른 원문 표기"],
          note: "번역에 필요한 의미/역할 메모",
        },
      ],
      characters: [
        {
          displayName: isDefault ? "한국어 표시명" : `${targetLabel} 표시명`,
          sourceNames: [isDefault ? "原文名" : "원문 이름"],
          targetName: isDefault ? "한국어 이름" : `${targetLabel} 이름`,
          aliases: ["별명"],
          speechStyle: "casual",
          customSpeechStyle: "custom일 때만 구체적으로",
          note: "관계/역할/말투 메모",
        },
      ],
      rules: {
        honorifics: "adapt",
        sfxMode: "translate",
        defaultTone: "natural_korean",
      },
      pageSummaries: [
        {
          chapterId: "제공된 chapterId",
          pageId: "제공된 pageId",
          summary: "쪽별 핵심 사건 한 문장",
          characterNames: ["캐릭터 이름"],
        },
      ],
    },
    null,
    2,
  );
}

function capText(value: unknown, maxLength: number): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}
