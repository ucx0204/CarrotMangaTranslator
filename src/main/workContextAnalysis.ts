import { mkdir } from "node:fs/promises";
import type {
  AnalyzeWorkContextRequest,
  AnalyzeWorkContextResult,
  ChapterSnapshot,
  ChapterStoryMemory,
  WorkContextAnalysisScope,
  WorkStyleGuide,
} from "../shared/types";
import { resolveLanguagePair } from "../shared/translationLanguages";
import { getAppPaths } from "./appPaths";
import { getAppSettings } from "./settingsStore";
import {
  getChapterStoryMemory,
  getRunPaths,
  getWorkStyleGuide,
  listLibrary,
  openChapter,
  saveChapterStoryMemory,
  saveWorkStyleGuide,
} from "./library";
import { buildBaseOptions } from "./pipeline/options";
import { loadTranslationRuntimePort } from "./pipeline/translationRuntimePort";
import type { ModelEndpointHandle } from "./pipeline/types";
import { runSequentialWorkAnalysis } from "./workContextSequentialAnalysis";
import {
  buildWorkContextAnalysisPrompt,
  buildWorkContextJsonRepairPrompt,
  selectWorkTextForAnalysis,
  type WorkTextSelection,
} from "./workContextAnalysisPrompt";
import { mergeAiWorkContextSuggestions } from "./workContextAiMerge";
import {
  buildAlreadyAnalyzedResult,
  filterUnanalyzedChapters,
} from "./workContextMissingScope";
import { normalizeAiWorkContextSuggestions } from "./workContextAiNormalize";
import { parseWorkContextModelJson } from "./workContextJsonParser";
import { requestWorkContextAnalysisText } from "./workContextModelRequest";
import { logInfo, logWarn } from "./logger";
import { tMain } from "./i18n";

const MAX_ANALYSIS_OUTPUT_TOKENS = 4096;
const MAX_GEMMA_ANALYSIS_OUTPUT_TOKENS = 2048;
const ANALYSIS_PROMPT_OVERHEAD_TOKENS = 1000;
const CHARS_PER_TOKEN_ESTIMATE = 2;
const DEFAULT_API_ANALYSIS_INPUT_CHARS = 64_000;
const MIN_ANALYSIS_INPUT_CHARS = 4_000;

export async function analyzeWorkContextWithAi(
  request: AnalyzeWorkContextRequest,
): Promise<AnalyzeWorkContextResult> {
  const chapters = await loadWorkChapters(request.chapterId);
  const currentChapter = chapters.find(
    (chapter) => chapter.id === request.chapterId,
  );
  if (!currentChapter) {
    throw new Error(tMain("workContext.errors.chapterNotFound"));
  }
  const guide = await getWorkStyleGuide(currentChapter.workId);
  const settings = await getAppSettings();
  const options = await buildAnalysisOptions(request.chapterId, settings);
  const maxInputChars = resolveAnalysisInputBudget({
    options,
    override: request.maxInputChars,
  });
  if (request.scope === "work") {
    return runSequentialWorkAnalysis({
      guide,
      request,
      chapters,
      workId: currentChapter.workId,
      options,
      maxInputChars,
      runChapterAnalysis: runAiAnalysisWithEndpoint,
    });
  }
  if (request.scope === "missing") {
    const unanalyzed = await filterUnanalyzedChapters(chapters);
    if (unanalyzed.length === 0) {
      return buildAlreadyAnalyzedResult({
        guide,
        chapterId: request.chapterId,
        workId: currentChapter.workId,
        totalChapters: chapters.length,
        maxInputChars,
      });
    }
    return runSequentialWorkAnalysis({
      guide,
      request,
      chapters: unanalyzed,
      workId: currentChapter.workId,
      options,
      maxInputChars,
      runChapterAnalysis: runAiAnalysisWithEndpoint,
    });
  }
  const selection = selectWorkTextForAnalysis({
    workId: currentChapter.workId,
    requestedChapterId: request.chapterId,
    chapters,
    scope: "chapter",
    maxInputChars,
    languagePair: resolveLanguagePair(options),
  });
  logAnalysisSelection(selection);
  if (!selection.text.trim()) {
    return buildEmptyAnalysisResult(guide, request.chapterId, selection);
  }
  return runAiAnalysis({
    guide,
    request,
    selection,
    options,
  });
}

async function runAiAnalysis({
  guide,
  request,
  selection,
  options,
}: {
  guide: WorkStyleGuide;
  request: AnalyzeWorkContextRequest;
  selection: WorkTextSelection;
  options: Awaited<ReturnType<typeof buildAnalysisOptions>>;
}): Promise<AnalyzeWorkContextResult> {
  const runtime = loadTranslationRuntimePort();
  const session = await runtime.startEndpointSession(options);
  try {
    return runAiAnalysisWithEndpoint({
      guide,
      request,
      selection,
      options,
      endpoint: session.handle,
    });
  } finally {
    await session.dispose();
  }
}

async function runAiAnalysisWithEndpoint({
  guide,
  request,
  selection,
  options,
  endpoint,
}: {
  guide: WorkStyleGuide;
  request: AnalyzeWorkContextRequest;
  selection: WorkTextSelection;
  options: Awaited<ReturnType<typeof buildAnalysisOptions>>;
  endpoint: ModelEndpointHandle;
}): Promise<AnalyzeWorkContextResult> {
  const prompt = buildWorkContextAnalysisPrompt({
    guide,
    selection,
    languagePair: resolveLanguagePair(options),
  });
  const rawText = await requestWorkContextAnalysisText({
    endpoint,
    options,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    maxOutputTokens: resolveAnalysisOutputTokens(options),
  });
  const parsed = await parseOrRepairAnalysisResponse({
    rawText,
    endpoint,
    options,
  });
  return persistAiAnalysisResult({
    guide,
    request,
    selection,
    parsed,
  });
}

async function persistAiAnalysisResult({
  guide,
  request,
  selection,
  parsed,
}: {
  guide: WorkStyleGuide;
  request: AnalyzeWorkContextRequest;
  selection: WorkTextSelection;
  parsed: unknown;
}): Promise<AnalyzeWorkContextResult> {
  const memories = await loadSelectedMemories(selection);
  const suggestions = normalizeAiWorkContextSuggestions(parsed);
  const merged = mergeAiWorkContextSuggestions({
    styleGuide: guide,
    memories,
    basePages: selection.basePages,
    suggestions,
  });
  const savedGuide = await saveWorkStyleGuide(merged.styleGuide);
  const savedMemories = await saveMemories(merged.memories);
  return {
    styleGuide: savedGuide,
    storyMemory:
      savedMemories.find((memory) => memory.chapterId === request.chapterId) ??
      (await getChapterStoryMemory(request.chapterId)),
    coverage: selection.coverage,
    counts: merged.counts,
    warnings: buildResultWarnings(selection, merged.warnings),
  };
}

async function loadWorkChapters(chapterId: string): Promise<ChapterSnapshot[]> {
  const currentChapter = await openChapter(chapterId);
  const library = await listLibrary();
  const work = library.works.find((item) => item.id === currentChapter.workId);
  if (!work) {
    return [currentChapter];
  }
  const chapters: ChapterSnapshot[] = [];
  for (const chapter of work.chapters) {
    chapters.push(await openChapter(chapter.id));
  }
  return chapters;
}

async function buildAnalysisOptions(
  chapterId: string,
  settings: Awaited<ReturnType<typeof getAppSettings>>,
) {
  const jobId = `context-${Date.now().toString(36)}`;
  const paths = getAppPaths();
  const runPaths = await getRunPaths(chapterId, jobId);
  await mkdir(runPaths.runDir, { recursive: true });
  return buildBaseOptions(jobId, runPaths.runDir, settings, paths);
}

async function loadSelectedMemories(
  selection: WorkTextSelection,
): Promise<ChapterStoryMemory[]> {
  const chapterIds = [
    ...new Set(selection.basePages.map((page) => page.chapterId)),
  ];
  return Promise.all(
    chapterIds.map((chapterId) => getChapterStoryMemory(chapterId)),
  );
}

async function saveMemories(
  memories: ChapterStoryMemory[],
): Promise<ChapterStoryMemory[]> {
  const saved: ChapterStoryMemory[] = [];
  for (const memory of memories) {
    saved.push(await saveChapterStoryMemory(memory));
  }
  return saved;
}

async function buildEmptyAnalysisResult(
  guide: WorkStyleGuide,
  chapterId: string,
  selection: WorkTextSelection,
): Promise<AnalyzeWorkContextResult> {
  return {
    styleGuide: guide,
    storyMemory: await getChapterStoryMemory(chapterId),
    coverage: selection.coverage,
    counts: {
      glossaryAdded: 0,
      glossaryUpdated: 0,
      charactersAdded: 0,
      charactersUpdated: 0,
      rulesUpdated: 0,
      pageSummariesUpserted: 0,
    },
    warnings: [tMain("workContext.warnings.noText")],
  };
}

function resolveAnalysisInputBudget({
  options,
  override,
}: {
  options: Awaited<ReturnType<typeof buildAnalysisOptions>>;
  override?: number;
}): number {
  if (override) {
    return override;
  }
  if (options.modelProvider === "gemma") {
    const availableTokens = Math.max(
      1000,
      options.ctx -
        resolveAnalysisOutputTokens(options) -
        ANALYSIS_PROMPT_OVERHEAD_TOKENS,
    );
    return Math.max(
      MIN_ANALYSIS_INPUT_CHARS,
      availableTokens * CHARS_PER_TOKEN_ESTIMATE,
    );
  }
  return DEFAULT_API_ANALYSIS_INPUT_CHARS;
}

function resolveAnalysisOutputTokens(
  options: Awaited<ReturnType<typeof buildAnalysisOptions>>,
): number {
  const cap =
    options.modelProvider === "gemma"
      ? MAX_GEMMA_ANALYSIS_OUTPUT_TOKENS
      : MAX_ANALYSIS_OUTPUT_TOKENS;
  return Math.min(options.maxTokens, cap);
}

function buildResultWarnings(
  selection: WorkTextSelection,
  warnings: string[],
): string[] {
  return [
    ...(selection.coverage.truncated
      ? [buildTruncatedWarning(selection.coverage.scope)]
      : []),
    ...warnings,
  ];
}

function buildTruncatedWarning(scope: WorkContextAnalysisScope): string {
  return scope === "work"
    ? tMain("workContext.warnings.workTruncated")
    : tMain("workContext.warnings.chapterTruncated");
}

function logAnalysisSelection(selection: WorkTextSelection): void {
  const pagesByChapter = new Map<string, number>();
  for (const page of selection.basePages) {
    pagesByChapter.set(
      page.chapterId,
      (pagesByChapter.get(page.chapterId) ?? 0) + 1,
    );
  }
  logInfo("AI work context selected text", {
    coverage: selection.coverage,
    pagesByChapter: Object.fromEntries(pagesByChapter),
  });
}

async function parseOrRepairAnalysisResponse({
  rawText,
  endpoint,
  options,
}: {
  rawText: string;
  endpoint: ModelEndpointHandle;
  options: Awaited<ReturnType<typeof buildAnalysisOptions>>;
}): Promise<unknown> {
  try {
    return parseWorkContextModelJson(rawText);
  } catch (error) {
    logWarn("AI work context JSON parse failed", {
      error,
      outputPreview: rawText.slice(0, 4000),
      outputLength: rawText.length,
    });
    return repairAnalysisResponse({
      rawText,
      endpoint,
      options,
      parseError: error,
    });
  }
}

async function repairAnalysisResponse({
  rawText,
  endpoint,
  options,
  parseError,
}: {
  rawText: string;
  endpoint: ModelEndpointHandle;
  options: Awaited<ReturnType<typeof buildAnalysisOptions>>;
  parseError: unknown;
}): Promise<unknown> {
  const prompt = buildWorkContextJsonRepairPrompt(
    rawText,
    resolveLanguagePair(options),
  );
  const repairedText = await requestWorkContextAnalysisText({
    endpoint,
    options,
    systemPrompt: prompt.systemPrompt,
    userPrompt: prompt.userPrompt,
    maxOutputTokens: resolveAnalysisOutputTokens(options),
  });
  try {
    return parseWorkContextModelJson(repairedText);
  } catch (repairError) {
    logWarn("AI work context JSON repair failed", {
      parseError,
      repairError,
      repairedOutputPreview: repairedText.slice(0, 4000),
      repairedOutputLength: repairedText.length,
    });
    throw repairError;
  }
}
