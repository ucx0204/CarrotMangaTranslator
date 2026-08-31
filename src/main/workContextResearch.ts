import { app } from "electron";
import { join } from "node:path";
import type { AppSettings } from "../shared/settingsTypes";
import type { TranslationOptions } from "./settings/appSettingsTypes";
import { createWorkContextResearchFingerprint } from "../shared/workContextResearchProposal";
import type {
  ResearchWorkContextRequest,
  WorkContextResearchProposal,
} from "../shared/workContextResearchTypes";
import type { ChapterSnapshot } from "../shared/libraryTypes";
import { resolveLanguagePair } from "../shared/translationLanguages";
import { getAppPaths } from "./appPaths";
import { CodexAppServerClient } from "./codexAppServerClient";
import type {
  CodexAppServerModel,
  CodexAppServerTurnResult,
} from "./codexAppServerProtocol";
import { runCodexWebResearchWithFallback } from "./codexWebResearchFallback";
import { getAppSettings } from "./settingsStore";
import { getChapterStoryMemory, listLibrary, openChapter } from "./library";
import {
  selectWorkTextForAnalysis,
  type WorkTextSelection,
} from "./workContextAnalysisPrompt";
import { parseWorkContextModelJson } from "./workContextJsonParser";
import { buildWorkContextUsageFromLoadedChapters } from "./workContextUsage";
import { researchWithTavily } from "./workContextResearchGemma";
import { postprocessWorkContextResearchInWorker } from "./workContextResearchPostprocessWorkerClient";
import {
  buildCodexWebResearchPrompt,
  type WorkContextResearchPromptInput,
} from "./workContextResearchPrompt";

const RESEARCH_FILE_READ_CONCURRENCY = 6;

export async function researchWorkContext(
  request: ResearchWorkContextRequest,
  signal?: AbortSignal,
  onProgress?: WorkContextResearchProgressHandler,
): Promise<WorkContextResearchProposal> {
  const settings = await getAppSettings();
  return researchWorkContextWithSettings(request, settings, signal, onProgress);
}

type WorkContextResearchProgress = Parameters<
  NonNullable<TranslationOptions["onProgress"]>
>[0];
export type WorkContextResearchProgressHandler = (
  progress: WorkContextResearchProgress,
) => void;

async function researchWorkContextWithSettings(
  request: ResearchWorkContextRequest,
  settings: AppSettings,
  signal?: AbortSignal,
  onProgress?: WorkContextResearchProgressHandler,
): Promise<WorkContextResearchProposal> {
  const startedAt = Date.now();
  signal?.throwIfAborted();
  onProgress?.({
    progressText: "조사 자료 준비 중",
    phase: "booting",
    detail:
      "저장된 용어와 OCR 텍스트를 조사에 필요한 범위로 정리하고 있습니다.",
    progressMode: "indeterminate",
    research: { stage: "preparing" },
  });
  const context = await loadResearchContext(request, settings, signal);
  signal?.throwIfAborted();
  const result =
    request.engine === "codex-web"
      ? await researchWithCodex(
          context.promptInput,
          settings,
          signal,
          onProgress,
        )
      : await researchWithTavily(
          context.promptInput,
          settings,
          signal,
          onProgress,
        );
  signal?.throwIfAborted();
  onProgress?.({
    progressText: "조사 결과 검증 중",
    phase: "finalizing",
    detail: "검색 근거를 대조하고 중복·오진을 정리하고 있습니다.",
    progressMode: "indeterminate",
    research: { stage: "finalizing" },
  });
  const normalized = await postprocessWorkContextResearchInWorker(
    {
      raw: result.raw,
      ...(result.searches ? { searches: result.searches } : {}),
      promptInput: context.promptInput,
      usage: context.usage,
      ...(result.allowedSourceUrls
        ? { allowedSourceUrls: [...result.allowedSourceUrls] }
        : {}),
    },
    signal,
  );
  return {
    engine: request.engine,
    baseFingerprint: createWorkContextResearchFingerprint(
      request.guideSnapshot,
    ),
    operations: normalized.operations,
    warnings: [...result.warnings, ...normalized.warnings].slice(0, 100),
    stats: {
      queryCount: result.queryCount,
      sourceCount: countProposalSources(normalized.operations),
      tavilyCreditsUsed: result.tavilyCreditsUsed,
      estimatedTokenDelta: normalized.estimatedTokenDelta,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

type LoadedResearchContext = {
  workId: string;
  selection: WorkTextSelection;
  usage: ReturnType<typeof buildWorkContextUsageFromLoadedChapters>;
  promptInput: WorkContextResearchPromptInput;
};

async function loadResearchContext(
  request: ResearchWorkContextRequest,
  settings: AppSettings,
  signal?: AbortSignal,
): Promise<LoadedResearchContext> {
  const [current, library] = await Promise.all([
    openChapter(request.chapterId),
    listLibrary(),
  ]);
  signal?.throwIfAborted();
  if (request.guideSnapshot.workId !== current.workId) {
    throw new Error("조사 초안이 현재 작품과 일치하지 않습니다.");
  }
  const work = library.works.find(
    (candidate) => candidate.id === current.workId,
  );
  if (!work) throw new Error("조사할 작품을 찾지 못했습니다.");
  const loadedChapters = await mapWithConcurrency(
    work.chapters,
    RESEARCH_FILE_READ_CONCURRENCY,
    async (summary) => {
      signal?.throwIfAborted();
      const [chapter, memory] = await Promise.all([
        summary.id === current.id ? current : openChapter(summary.id),
        getChapterStoryMemory(summary.id),
      ]);
      signal?.throwIfAborted();
      return { chapter, memory };
    },
  );
  const chapters: ChapterSnapshot[] = loadedChapters.map(
    ({ chapter }) => chapter,
  );
  const { contextTokens, outputTokens } = resolveResearchLimits(
    request.engine,
    settings,
  );
  const maxInputChars = Math.max(
    4_000,
    Math.min(150_000, Math.max(8_000, contextTokens - outputTokens) * 2),
  );
  const selection = selectWorkTextForAnalysis({
    workId: current.workId,
    requestedChapterId: current.id,
    chapters,
    scope: "work",
    maxInputChars,
    languagePair: resolveLanguagePair(settings.translation),
    priorityTerms: collectGuideResearchTerms(request.guideSnapshot),
    spreadAcrossWork: true,
  });
  return {
    workId: current.workId,
    selection,
    usage: buildWorkContextUsageFromLoadedChapters(
      current.workId,
      request.guideSnapshot,
      loadedChapters,
      signal,
    ),
    promptInput: {
      workTitle: request.researchTitle,
      guide: request.guideSnapshot,
      selection,
    },
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const batchSize = Math.max(1, concurrency);
  for (let start = 0; start < values.length; start += batchSize) {
    const batch = values.slice(start, start + batchSize);
    results.push(...(await Promise.all(batch.map(worker))));
  }
  return results;
}

function collectGuideResearchTerms(
  guide: ResearchWorkContextRequest["guideSnapshot"],
): string[] {
  return [
    ...guide.glossary.flatMap((entry) => [
      entry.source,
      entry.target,
      ...(entry.aliases ?? []),
    ]),
    ...guide.characters.flatMap((entry) => [
      entry.displayName,
      entry.targetName,
      ...entry.sourceNames,
      ...(entry.aliases ?? []),
    ]),
  ].filter((value) => value.trim().length >= 2);
}

function resolveResearchLimits(
  engine: ResearchWorkContextRequest["engine"],
  settings: AppSettings,
): { contextTokens: number; outputTokens: number } {
  if (engine === "codex-web") {
    return {
      contextTokens: settings.internetResearch.codexContextTokens,
      outputTokens: settings.internetResearch.codexMaxOutputTokens,
    };
  }
  return settings.internetResearch.tavilyAnalysisProvider === "api"
    ? {
        contextTokens: settings.internetResearch.apiContextTokens,
        outputTokens: settings.internetResearch.apiMaxOutputTokens,
      }
    : {
        contextTokens: settings.internetResearch.gemmaContextTokens,
        outputTokens: settings.internetResearch.gemmaMaxOutputTokens,
      };
}

type RawResearchResult = {
  raw: unknown;
  searches?: readonly import("./tavilyClient").TavilySearchResponse[];
  queryCount: number;
  tavilyCreditsUsed: number;
  warnings: string[];
  allowedSourceUrls?: ReadonlySet<string>;
};

async function researchWithCodex(
  promptInput: WorkContextResearchPromptInput,
  settings: AppSettings,
  signal?: AbortSignal,
  onProgress?: WorkContextResearchProgressHandler,
): Promise<RawResearchResult> {
  emitCodexResearchProgress(onProgress, {
    stage: "preparing",
    progressText: "Codex 연결 확인 중",
    detail: "로그인 상태와 사용할 조사 모델을 확인하고 있습니다.",
  });
  const paths = getAppPaths();
  const client = await CodexAppServerClient.start({
    paths,
    appVersion: app.getVersion(),
    capability: "research",
  });
  try {
    const models = await validateCodexResearchAccess(
      client,
      settings.internetResearch.codexModel,
    );
    const prompt = buildCodexWebResearchPrompt(promptInput, {
      maxOutputTokens: settings.internetResearch.codexMaxOutputTokens,
    });
    emitCodexResearchProgress(onProgress, {
      stage: "planning",
      progressText: "Codex 조사 요청 구성 중",
      detail: "기존 용어와 캐릭터를 기준으로 조사 목표를 구성하고 있습니다.",
    });
    emitCodexResearchProgress(onProgress, {
      stage: "searching",
      progressText: "Codex 웹 조사 중",
      detail:
        "Codex가 필요한 출처를 검색하고 번역에 유용한 근거를 선별하고 있습니다.",
    });
    const runResearchTurn = (
      model: string,
      effort: string,
    ): Promise<CodexAppServerTurnResult> =>
      client.runEphemeralTurn({
        model,
        effort,
        instructions: prompt.instructions,
        input: [{ type: "text", text: prompt.userPrompt }],
        cwd:
          paths.codexWorkspaceDir ?? join(paths.dataRoot, ".codex-workspace"),
        outputSchema: prompt.outputSchema,
        contextWindowTokens: settings.internetResearch.codexContextTokens,
        signal,
      });
    const { result, warnings } = await runCodexWebResearchWithFallback({
      models,
      selectedModel: settings.internetResearch.codexModel,
      selectedEffort: settings.internetResearch.codexReasoningEffort,
      runTurn: runResearchTurn,
      signal,
      onFallback: (fallback) =>
        emitCodexResearchProgress(onProgress, {
          stage: "searching",
          progressText: "호환 Codex 모델로 웹 조사 재시도 중",
          detail: `${settings.internetResearch.codexModel} 세션에 직접 웹 검색 도구가 없어 ${fallback.model}로 다시 조사하고 있습니다.`,
        }),
    });
    emitCodexResearchProgress(onProgress, {
      stage: "synthesizing",
      progressText: "조사 결과 정리 중",
      detail: `${result.webSearchCount ?? 0}회의 웹 검색 결과에서 변경안을 정리하고 있습니다.`,
    });
    return {
      raw: parseWorkContextModelJson(result.text),
      queryCount: result.webSearchCount ?? 0,
      tavilyCreditsUsed: 0,
      warnings,
    };
  } finally {
    await client.dispose();
  }
}

async function validateCodexResearchAccess(
  client: CodexAppServerClient,
  selectedModel: string,
): Promise<CodexAppServerModel[]> {
  const account = await client.readAccount(false);
  if (account.requiresOpenaiAuth && !account.account) {
    throw new Error(
      "Codex 로그인이 필요합니다. 설정 > LLM > 인터넷 조사에서 로그인해 주세요.",
    );
  }
  const models = await client.listModels();
  if (
    models.length > 0 &&
    !models.some((model) => model.id === selectedModel)
  ) {
    throw new Error(
      "선택한 Codex 조사 모델을 현재 계정에서 사용할 수 없습니다.",
    );
  }
  return models;
}

function emitCodexResearchProgress(
  onProgress: WorkContextResearchProgressHandler | undefined,
  progress: {
    stage: "preparing" | "planning" | "searching" | "synthesizing";
    progressText: string;
    detail: string;
  },
): void {
  onProgress?.({
    progressText: progress.progressText,
    phase: progress.stage === "preparing" ? "booting" : "model_requesting",
    detail: progress.detail,
    progressMode: "indeterminate",
    research: { stage: progress.stage },
  });
}

function countProposalSources(
  operations: WorkContextResearchProposal["operations"],
): number {
  return new Set(
    operations.flatMap((operation) =>
      operation.sources.map((source) => source.url),
    ),
  ).size;
}
