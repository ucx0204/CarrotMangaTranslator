import type {
  AnalyzeWorkContextRequest,
  AnalyzeWorkContextResult,
  ChapterSnapshot,
  WorkContextAnalysisCounts,
  WorkStyleGuide,
} from "../shared/types";
import type { TranslationOptions } from "./appSettings";
import { getChapterStoryMemory } from "./library";
import { logWarn } from "./logger";
import { loadTranslationRuntimePort } from "./pipeline/translationRuntimePort";
import type { ModelEndpointHandle } from "./pipeline/types";
import { resolveLanguagePair } from "../shared/translationLanguages";
import {
  selectWorkTextForAnalysis,
  type WorkTextSelection,
} from "./workContextAnalysisPrompt";
import { createEmptyCounts } from "./workContextAiMergeUtils";

type RunChapterAnalysis = (input: {
  guide: WorkStyleGuide;
  request: AnalyzeWorkContextRequest;
  selection: WorkTextSelection;
  options: TranslationOptions;
  endpoint: ModelEndpointHandle;
}) => Promise<AnalyzeWorkContextResult>;

export async function runSequentialWorkAnalysis({
  guide,
  request,
  chapters,
  workId,
  options,
  maxInputChars,
  runChapterAnalysis,
}: {
  guide: WorkStyleGuide;
  request: AnalyzeWorkContextRequest;
  chapters: ChapterSnapshot[];
  workId: string;
  options: TranslationOptions;
  maxInputChars: number;
  runChapterAnalysis: RunChapterAnalysis;
}): Promise<AnalyzeWorkContextResult> {
  const runtime = loadTranslationRuntimePort();
  const session = await runtime.startEndpointSession(options);
  const state = createSequentialState({
    guide,
    workId,
    request,
    chapters,
    maxInputChars,
  });
  try {
    for (const chapter of chapters) {
      await analyzeSequentialChapter({
        chapter,
        state,
        request,
        chapters,
        workId,
        options,
        maxInputChars,
        endpoint: session.handle,
        runChapterAnalysis,
      });
    }
  } finally {
    await session.dispose();
  }

  if (state.analyzedChapters === 0 && state.errors.length > 0) {
    throw state.errors[0];
  }

  return {
    styleGuide: state.guide,
    storyMemory: await getChapterStoryMemory(request.chapterId),
    coverage: state.coverage,
    counts: state.counts,
    warnings: buildSequentialWarnings({
      warnings: state.warnings,
      truncatedChapters: state.truncatedChapters,
      failedChapters: state.errors.length,
    }),
  };
}

type SequentialState = {
  guide: WorkStyleGuide;
  coverage: AnalyzeWorkContextResult["coverage"];
  counts: WorkContextAnalysisCounts;
  warnings: string[];
  errors: unknown[];
  truncatedChapters: number;
  analyzedChapters: number;
};

function createSequentialState({
  guide,
  workId,
  request,
  chapters,
  maxInputChars,
}: {
  guide: WorkStyleGuide;
  workId: string;
  request: AnalyzeWorkContextRequest;
  chapters: ChapterSnapshot[];
  maxInputChars: number;
}): SequentialState {
  return {
    guide,
    coverage: createWorkCoverage({
      workId,
      requestedChapterId: request.chapterId,
      chapters,
      maxInputChars,
    }),
    counts: createEmptyCounts(),
    warnings: [],
    errors: [],
    truncatedChapters: 0,
    analyzedChapters: 0,
  };
}

async function analyzeSequentialChapter({
  chapter,
  state,
  request,
  chapters,
  workId,
  options,
  maxInputChars,
  endpoint,
  runChapterAnalysis,
}: {
  chapter: ChapterSnapshot;
  state: SequentialState;
  request: AnalyzeWorkContextRequest;
  chapters: ChapterSnapshot[];
  workId: string;
  options: TranslationOptions;
  maxInputChars: number;
  endpoint: ModelEndpointHandle;
  runChapterAnalysis: RunChapterAnalysis;
}): Promise<void> {
  const selection = selectWorkTextForAnalysis({
    workId,
    requestedChapterId: chapter.id,
    chapters,
    scope: "chapter",
    maxInputChars,
    languagePair: resolveLanguagePair(options),
  });
  mergeCoverage(state.coverage, selection.coverage);
  if (selection.coverage.truncated) {
    state.truncatedChapters += 1;
  }
  if (!selection.text.trim()) {
    state.warnings.push(
      `${chapter.title}: 분석할 텍스트가 없어 건너뛰었습니다.`,
    );
    return;
  }
  await persistSequentialChapter({
    chapter,
    state,
    request,
    selection,
    options,
    endpoint,
    runChapterAnalysis,
  });
}

async function persistSequentialChapter({
  chapter,
  state,
  request,
  selection,
  options,
  endpoint,
  runChapterAnalysis,
}: {
  chapter: ChapterSnapshot;
  state: SequentialState;
  request: AnalyzeWorkContextRequest;
  selection: WorkTextSelection;
  options: TranslationOptions;
  endpoint: ModelEndpointHandle;
  runChapterAnalysis: RunChapterAnalysis;
}): Promise<void> {
  try {
    const result = await runChapterAnalysis({
      guide: state.guide,
      request: { ...request, chapterId: chapter.id, scope: "chapter" },
      selection,
      options,
      endpoint,
    });
    state.guide = result.styleGuide;
    addCounts(state.counts, result.counts);
    state.analyzedChapters += 1;
    state.warnings.push(...prefixWarnings(chapter.title, result.warnings));
  } catch (error) {
    state.errors.push(error);
    logWarn("AI work context chapter analysis failed", {
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      error,
    });
    state.warnings.push(`${chapter.title}: AI 분석에 실패해 건너뛰었습니다.`);
  }
}

function createWorkCoverage({
  workId,
  requestedChapterId,
  chapters,
  maxInputChars,
}: {
  workId: string;
  requestedChapterId: string;
  chapters: ChapterSnapshot[];
  maxInputChars: number;
}): AnalyzeWorkContextResult["coverage"] {
  return {
    scope: "work",
    workId,
    requestedChapterId,
    totalChapters: chapters.length,
    includedChapters: 0,
    totalPages: chapters.reduce(
      (sum, chapter) => sum + chapter.pages.length,
      0,
    ),
    includedPages: 0,
    selectedChars: 0,
    maxInputChars,
    truncated: false,
  };
}

function mergeCoverage(
  target: AnalyzeWorkContextResult["coverage"],
  source: AnalyzeWorkContextResult["coverage"],
): void {
  target.includedChapters += source.includedChapters;
  target.includedPages += source.includedPages;
  target.selectedChars += source.selectedChars;
  target.truncated = target.truncated || source.truncated;
}

function addCounts(
  target: WorkContextAnalysisCounts,
  source: WorkContextAnalysisCounts,
): void {
  target.glossaryAdded += source.glossaryAdded;
  target.glossaryUpdated += source.glossaryUpdated;
  target.charactersAdded += source.charactersAdded;
  target.charactersUpdated += source.charactersUpdated;
  target.rulesUpdated += source.rulesUpdated;
  target.pageSummariesUpserted += source.pageSummariesUpserted;
}

function prefixWarnings(chapterTitle: string, warnings: string[]): string[] {
  return warnings
    .filter((warning) => !warning.includes("현재 화 텍스트가 길어"))
    .map((warning) => `${chapterTitle}: ${warning}`);
}

function buildSequentialWarnings({
  warnings,
  truncatedChapters,
  failedChapters,
}: {
  warnings: string[];
  truncatedChapters: number;
  failedChapters: number;
}): string[] {
  const result = [
    ...(truncatedChapters > 0
      ? [
          `${truncatedChapters}개 화가 길어 각 화의 토큰 예산 안에서 일부 쪽만 AI 분석에 포함했습니다.`,
        ]
      : []),
    ...dedupeWarnings(warnings),
    ...(failedChapters > 0
      ? [
          `${failedChapters}개 화는 AI 분석에 실패했습니다. 로그를 확인해 주세요.`,
        ]
      : []),
  ];
  return result.slice(0, 8);
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.filter((warning) => warning.trim()))];
}
