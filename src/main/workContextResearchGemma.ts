/* eslint-disable complexity, max-depth, max-lines, max-lines-per-function -- one Tavily research transaction keeps endpoint lifetime, credit accounting, evidence collection, and bounded repair ordering auditable */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMMA_MODEL_PRESETS } from "../shared/modelPresets";
import type { AppSettings } from "../shared/settingsTypes";
import type { TranslationOptions } from "./settings/appSettingsTypes";
import { getAppPaths } from "./appPaths";
import { buildBaseOptions } from "./pipeline/options";
import type { ModelEndpointHandle } from "./pipeline/types";
import {
  getTavilyUsage,
  searchTavily,
  type TavilySearchResponse,
} from "./tavilyClient";
import { loadTranslationRuntimePort } from "./translationRuntime";
import { parseWorkContextModelJson } from "./workContextJsonParser";
import { requestWorkContextAnalysisText } from "./workContextModelRequest";
import {
  buildTranslatedCriticalEvidenceOperations,
  extractTrustedEvidenceTitles,
  mergeResearchResults,
  selectCriticalEvidenceTranslationCandidates,
  type CriticalEvidenceTranslation,
} from "./workContextResearchEvidence";
import {
  buildGemmaCriticalCandidateTranslationPrompt,
  buildGemmaResearchSynthesisPrompt,
  buildGemmaResearchAuditPrompt,
  buildResearchJsonRepairPrompt,
  buildResearchQueryPlanningPrompt,
  extractCreatorAttributionNames,
  extractLocalResearchCandidates,
  extractRoleBoundJapaneseNames,
  extractRoleBoundKatakanaNames,
  isResearchResultRelevant,
  parseResearchQueries,
  type WorkContextResearchPromptInput,
} from "./workContextResearchPrompt";
import {
  extractQuotedJapaneseTitleCandidates,
  extractLatinTitleSearchAnchor,
  extractLikelyOriginalTitles,
  needsJapaneseTitleRecovery,
} from "./workContextResearchTitles";

const QUERY_PLANNING_MAX_OUTPUT_TOKENS = 768;

export type TavilyResearchResult = {
  raw: unknown;
  searches: readonly TavilySearchResponse[];
  queryCount: number;
  tavilyCreditsUsed: number;
  warnings: string[];
  allowedSourceUrls: ReadonlySet<string>;
};

export async function researchWithTavily(
  promptInput: WorkContextResearchPromptInput,
  settings: AppSettings,
  signal?: AbortSignal,
  onProgress?: TranslationOptions["onProgress"],
): Promise<TavilyResearchResult> {
  const apiKey = settings.internetResearch.tavilyApiKey?.trim();
  if (!apiKey) throw new Error("Tavily API 키를 먼저 입력해 주세요.");
  onProgress?.({
    progressText: "Tavily 사용 가능량 확인 중",
    phase: "booting",
    detail: "API 키와 사용할 수 있는 조사 크레딧을 확인하고 있습니다.",
    progressMode: "indeterminate",
    research: { stage: "preparing" },
  });
  const usage = await getTavilyUsage(apiKey, { signal });
  const maximumCredits = resolveMaximumCredits(settings, usage);
  if (maximumCredits < 1) {
    throw new Error(
      "Tavily 포함 크레딧이 남아 있지 않아 조사를 시작하지 않았습니다.",
    );
  }
  const temporaryRunDir = await mkdtemp(join(tmpdir(), "manga-research-"));
  let session: Awaited<
    ReturnType<
      ReturnType<typeof loadTranslationRuntimePort>["startEndpointSession"]
    >
  > | null = null;
  try {
    const options = await buildTavilyAnalysisOptions(
      settings,
      temporaryRunDir,
      onProgress,
    );
    options.abortSignal = signal;
    session = await loadTranslationRuntimePort().startEndpointSession(options);
    onProgress?.({
      progressText: "검색 계획 구성 중",
      phase: "model_requesting",
      detail: "기존 용어와 작품 정보를 바탕으로 검색 순서를 만들고 있습니다.",
      progressMode: "indeterminate",
      research: {
        stage: "planning",
        creditsUsed: 0,
        creditLimit: maximumCredits,
      },
    });
    const queries = await planQueries(
      promptInput,
      maximumCredits,
      session.handle,
      options,
    );
    const evidence = await collectTavilyEvidence({
      apiKey,
      maximumCredits,
      queries,
      promptInput,
      signal,
      onProgress,
    });
    const { searches, sourceUrls, spent } = evidence;
    if (searches.every((search) => search.results.length === 0)) {
      throw new Error(
        "Tavily 검색 결과에서 현재 작품과 일치하는 근거를 찾지 못했습니다.",
      );
    }
    onProgress?.({
      progressText: "용어와 캐릭터 정리 중",
      phase: "model_requesting",
      detail: "수집한 웹 근거를 번역에 필요한 변경안으로 정리하고 있습니다.",
      progressMode: "indeterminate",
      research: {
        stage: "synthesizing",
        creditsUsed: spent,
        creditLimit: maximumCredits,
      },
    });
    const prompt = buildGemmaResearchSynthesisPrompt(promptInput, searches);
    const rawText = await requestWorkContextAnalysisText({
      endpoint: session.handle,
      options,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens: resolveTavilyAnalysisMaxOutputTokens(settings),
    });
    const initial = await parseOrRepairResearchResponse(
      rawText,
      session.handle,
      options,
      resolveTavilyAnalysisMaxOutputTokens(settings),
    );
    onProgress?.({
      progressText: "변경안 교차 검증 중",
      phase: "model_requesting",
      detail:
        "오진과 불필요한 항목을 걸러내고 기존 항목과의 충돌을 확인하고 있습니다.",
      progressMode: "indeterminate",
      research: {
        stage: "auditing",
        creditsUsed: spent,
        creditLimit: maximumCredits,
      },
    });
    const audited = await auditResearchResponse({
      initial,
      promptInput,
      searches,
      endpoint: session.handle,
      options,
      maxOutputTokens: resolveTavilyAnalysisMaxOutputTokens(settings),
    });
    onProgress?.({
      progressText: "핵심 항목 누락 확인 중",
      phase: "model_requesting",
      detail:
        "등장인물과 번역 일관성에 중요한 고유 용어가 빠지지 않았는지 확인하고 있습니다.",
      progressMode: "indeterminate",
      research: {
        stage: "auditing",
        creditsUsed: spent,
        creditLimit: maximumCredits,
      },
    });
    const coverageRepaired = await repairCriticalEvidenceCoverage({
      current: audited,
      promptInput,
      searches,
      endpoint: session.handle,
      options,
      maxOutputTokens: resolveTavilyAnalysisMaxOutputTokens(settings),
    });
    return {
      raw: coverageRepaired,
      searches,
      queryCount: searches.length,
      tavilyCreditsUsed: spent,
      warnings: [],
      allowedSourceUrls: sourceUrls,
    };
  } finally {
    await session?.dispose();
    await rm(temporaryRunDir, { recursive: true, force: true }).catch(() => {
      // error-policy-allow: a temporary research run must not hide the result.
    });
  }
}

async function repairCriticalEvidenceCoverage({
  current,
  promptInput,
  searches,
  endpoint,
  options,
  maxOutputTokens,
}: {
  current: unknown;
  promptInput: WorkContextResearchPromptInput;
  searches: readonly TavilySearchResponse[];
  endpoint: ModelEndpointHandle;
  options: Awaited<ReturnType<typeof buildTavilyAnalysisOptions>>;
  maxOutputTokens: number;
}): Promise<unknown> {
  const currentOperations =
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    Array.isArray((current as { operations?: unknown }).operations)
      ? ((current as { operations: unknown[] }).operations ?? [])
      : [];
  const candidates = selectCriticalEvidenceTranslationCandidates(
    currentOperations,
    searches,
    promptInput,
  );
  if (candidates.length === 0) return current;
  try {
    const translations: CriticalEvidenceTranslation[] = [];
    let pending = [...candidates];
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
      const prompt = buildGemmaCriticalCandidateTranslationPrompt(
        promptInput,
        searches,
        pending,
      );
      const response = await requestWorkContextAnalysisText({
        endpoint,
        options: {
          ...options,
          gemmaReasoningBudget: Math.min(
            options.gemmaReasoningBudget ?? 0,
            2_048,
          ),
        },
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        maxOutputTokens: Math.min(4_096, maxOutputTokens),
      });
      const parsed = parseCriticalEvidenceTranslations(response, pending);
      translations.push(...parsed);
      const translatedKeys = new Set(
        translations.map((translation) =>
          normalizeQueryIdentity(translation.source),
        ),
      );
      pending = candidates.filter(
        (candidate) => !translatedKeys.has(normalizeQueryIdentity(candidate)),
      );
    }
    const operations = buildTranslatedCriticalEvidenceOperations(
      translations,
      searches,
      promptInput,
      candidates,
    );
    return operations.length > 0
      ? mergeResearchResults(current, { operations, warnings: [] })
      : current;
  } catch (_error) {
    return current;
  }
}

function parseCriticalEvidenceTranslations(
  rawText: string,
  candidates: readonly string[],
): CriticalEvidenceTranslation[] {
  const parsed = parseWorkContextModelJson(rawText) as {
    translations?: unknown;
  };
  if (!Array.isArray(parsed?.translations)) return [];
  const canonicalCandidates = new Map(
    candidates.map((candidate) => [
      normalizeQueryIdentity(candidate),
      candidate,
    ]),
  );
  const seen = new Set<string>();
  return parsed.translations.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    if (
      typeof record.source !== "string" ||
      typeof record.target !== "string"
    ) {
      return [];
    }
    const key = normalizeQueryIdentity(record.source);
    const source = canonicalCandidates.get(key);
    const target = record.target.replace(/\s+/gu, " ").trim();
    if (
      !source ||
      !target ||
      seen.has(key) ||
      (/^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(source) &&
        source.split("・").filter(Boolean).length >
          target.split(/\s+/u).filter(Boolean).length)
    ) {
      return [];
    }
    seen.add(key);
    return [{ source, target }];
  });
}

function resolveMaximumCredits(
  settings: AppSettings,
  usage: Awaited<ReturnType<typeof getTavilyUsage>>,
): number {
  const remainingLimits = [
    usage.key?.remaining,
    usage.account?.remaining,
  ].filter((value): value is number => typeof value === "number");
  return Math.min(
    settings.internetResearch.tavilyMaxCreditsPerRun,
    ...remainingLimits.map(Math.floor),
  );
}

async function auditResearchResponse({
  initial,
  promptInput,
  searches,
  endpoint,
  options,
  maxOutputTokens,
}: {
  initial: unknown;
  promptInput: WorkContextResearchPromptInput;
  searches: readonly TavilySearchResponse[];
  endpoint: ModelEndpointHandle;
  options: Awaited<ReturnType<typeof buildTavilyAnalysisOptions>>;
  maxOutputTokens: number;
}): Promise<unknown> {
  const prompt = buildGemmaResearchAuditPrompt(promptInput, searches, initial);
  try {
    const audited = await requestWorkContextAnalysisText({
      endpoint,
      options,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens,
    });
    const parsedAudit = await parseOrRepairResearchResponse(
      audited,
      endpoint,
      options,
      maxOutputTokens,
    );
    return mergeResearchResults(initial, parsedAudit);
  } catch (_error) {
    return initial;
  }
}

async function collectTavilyEvidence({
  apiKey,
  maximumCredits,
  queries,
  promptInput,
  signal,
  onProgress,
}: {
  apiKey: string;
  maximumCredits: number;
  queries: string[];
  promptInput: WorkContextResearchPromptInput;
  signal?: AbortSignal;
  onProgress?: TranslationOptions["onProgress"];
}): Promise<{
  searches: TavilySearchResponse[];
  sourceUrls: Set<string>;
  spent: number;
  trustedTitles: string[];
}> {
  const searches: TavilySearchResponse[] = [];
  const sourceUrls = new Set<string>();
  const trustedTitles: string[] = [];
  const pendingQueries = [...queries];
  const scheduledQueries = new Set(
    pendingQueries.map((query) => normalizeQueryIdentity(query)),
  );
  let characterExpansionScheduled = false;
  let spent = 0;
  while (pendingQueries.length > 0) {
    const query = pendingQueries.shift() ?? "";
    signal?.throwIfAborted();
    if (spent >= maximumCredits) break;
    onProgress?.({
      progressText: "웹 근거 수집 중",
      phase: "model_requesting",
      detail: query,
      progressMode: "determinate",
      progressCurrent: Math.min(spent, maximumCredits),
      progressTotal: maximumCredits,
      research: {
        stage: "searching",
        query,
        queryIndex: searches.length + 1,
        creditsUsed: spent,
        creditLimit: maximumCredits,
      },
    });
    const search = await searchForEvidence(
      apiKey,
      query,
      searches.length,
      promptInput,
      trustedTitles,
      signal,
    );
    if (!search) break;
    searches.push(search);
    spent += search.credits;
    onProgress?.({
      progressText: "웹 근거 수집 중",
      phase: "model_requesting",
      detail: query,
      progressMode: "determinate",
      progressCurrent: Math.min(spent, maximumCredits),
      progressTotal: maximumCredits,
      research: {
        stage: "searching",
        query,
        queryIndex: searches.length,
        resultCount: search.results.length,
        creditsUsed: spent,
        creditLimit: maximumCredits,
      },
    });
    search.results.forEach((result) => sourceUrls.add(result.url));
    const discoveredTitles = needsJapaneseTitleRecovery(promptInput.workTitle)
      ? extractTrustedEvidenceTitles(searches, promptInput).filter(
          (title) =>
            !trustedTitles.some(
              (current) =>
                normalizeQueryIdentity(current) ===
                normalizeQueryIdentity(title),
            ),
        )
      : [];
    if (discoveredTitles.length > 0) {
      trustedTitles.push(...discoveredTitles);
      const followUps = discoveredTitles.flatMap((title) =>
        buildRecoveredTitleFollowUpQueries(title, promptInput),
      );
      for (const followUp of followUps.reverse()) {
        const key = normalizeQueryIdentity(followUp);
        if (scheduledQueries.has(key)) continue;
        scheduledQueries.add(key);
        pendingQueries.unshift(followUp);
      }
      continue;
    }
    if (!characterExpansionScheduled) {
      const characterAnchors = dedupeQueries(
        search.results.flatMap((result) =>
          extractRoleBoundKatakanaNames(`${result.title}\n${result.content}`),
        ),
      ).slice(0, 2);
      const followUps = buildEvidenceAnchoredCharacterQueries(
        promptInput,
        characterAnchors,
        trustedTitles,
      );
      if (followUps.length > 0) {
        characterExpansionScheduled = true;
        for (const followUp of followUps.reverse()) {
          const key = normalizeQueryIdentity(followUp);
          if (scheduledQueries.has(key)) continue;
          scheduledQueries.add(key);
          pendingQueries.unshift(followUp);
        }
      }
    }
  }
  return { searches, sourceUrls, spent, trustedTitles };
}

async function searchForEvidence(
  apiKey: string,
  query: string,
  completedSearches: number,
  promptInput: WorkContextResearchPromptInput,
  trustedTitles: readonly string[],
  signal?: AbortSignal,
): Promise<TavilySearchResponse | null> {
  try {
    const response = await searchTavily(apiKey, query, {
      signal,
      exactMatch: shouldUseExactTitleMatch(query, promptInput),
    });
    return {
      ...response,
      results: response.results.filter((result) =>
        isResearchResultRelevant(result, promptInput, query, trustedTitles),
      ),
    };
  } catch (error) {
    if (isTavilyQuotaError(error) && completedSearches > 0) return null;
    throw error;
  }
}

function normalizeQueryIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase();
}

async function buildTavilyAnalysisOptions(
  settings: AppSettings,
  runDir: string,
  onProgress?: TranslationOptions["onProgress"],
) {
  const researchSettings = buildTavilyAnalysisSettings(settings);
  await mkdir(runDir, { recursive: true });
  const options = buildBaseOptions(
    `research-${Date.now().toString(36)}`,
    runDir,
    researchSettings,
    getAppPaths(),
  );
  if (researchSettings.modelProvider === "gemma") {
    options.textOnlyModel = true;
    options.mmprojOffload = false;
    options.gemmaReasoningBudget = resolveGemmaResearchReasoningBudget(
      settings,
      options.ctx,
    );
  }
  options.onProgress = onProgress;
  return options;
}

function resolveGemmaResearchReasoningBudget(
  settings: AppSettings,
  runtimeContextTokens: number,
): number {
  const configured = {
    none: 0,
    low: 2_048,
    medium: 4_096,
    high: 8_192,
  }[settings.internetResearch.gemmaReasoningEffort];
  return capGemmaResearchReasoningBudget(
    configured,
    settings.internetResearch.gemmaMaxOutputTokens,
    runtimeContextTokens,
  );
}

export function capGemmaResearchReasoningBudget(
  configured: number,
  maxOutputTokens: number,
  runtimeContextTokens: number,
): number {
  return Math.min(
    Math.max(0, Math.floor(configured)),
    Math.max(0, Math.floor(maxOutputTokens / 2)),
    Math.max(0, Math.floor(runtimeContextTokens / 4)),
  );
}

function buildTavilyAnalysisSettings(settings: AppSettings): AppSettings {
  if (settings.internetResearch.tavilyAnalysisProvider === "api") {
    return {
      ...settings,
      modelProvider: "openai-api",
      api: {
        ...settings.api,
        model: settings.internetResearch.apiModel,
      },
      maxTokens: settings.internetResearch.apiMaxOutputTokens,
      ctx: settings.internetResearch.apiContextTokens,
    };
  }
  const preset =
    settings.gemma.modelSource === "huggingface" &&
    settings.internetResearch.gemmaPreset !== "custom"
      ? GEMMA_MODEL_PRESETS[settings.internetResearch.gemmaPreset]
      : null;
  return {
    ...settings,
    modelProvider: "gemma",
    gemma: preset ? { ...settings.gemma, ...preset } : settings.gemma,
    maxTokens: settings.internetResearch.gemmaMaxOutputTokens,
    ctx: settings.internetResearch.gemmaContextTokens,
  };
}

function resolveTavilyAnalysisMaxOutputTokens(settings: AppSettings): number {
  return settings.internetResearch.tavilyAnalysisProvider === "api"
    ? settings.internetResearch.apiMaxOutputTokens
    : settings.internetResearch.gemmaMaxOutputTokens;
}

async function planQueries(
  promptInput: WorkContextResearchPromptInput,
  maximumQueries: number,
  endpoint: ModelEndpointHandle,
  options: Awaited<ReturnType<typeof buildTavilyAnalysisOptions>>,
): Promise<string[]> {
  const prompt = buildResearchQueryPlanningPrompt(promptInput, maximumQueries);
  let modelQueries: string[] = [];
  try {
    const planningOptions = {
      ...options,
      gemmaReasoningBudget: 0,
    };
    const rawText = await requestWorkContextAnalysisText({
      endpoint,
      options: planningOptions,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens: Math.min(
        QUERY_PLANNING_MAX_OUTPUT_TOKENS,
        options.maxTokens,
      ),
    });
    modelQueries = parseResearchQueries(
      parseWorkContextModelJson(rawText),
      maximumQueries,
    );
  } catch (_error) {
    // error-policy-allow: deterministic official-source queries remain usable.
  }
  return mergeResearchQueryPlan(
    promptInput,
    buildDeterministicResearchQueries(promptInput),
    modelQueries,
    maximumQueries,
  );
}

export function mergeResearchQueryPlan(
  promptInput: WorkContextResearchPromptInput,
  deterministicQueries: readonly string[],
  modelQueries: readonly string[],
  maximumQueries: number,
): string[] {
  const recoveryModelQueries =
    prioritizeNativeTitleRecoveryQueries(modelQueries);
  const queries = needsJapaneseTitleRecovery(promptInput.workTitle)
    ? [
        ...deterministicQueries.slice(0, 2),
        ...recoveryModelQueries.slice(0, 3),
        ...deterministicQueries.slice(2),
      ]
    : [...deterministicQueries, ...modelQueries];
  const merged = dedupeQueries([
    ...queries,
    `"${promptInput.workTitle}" 登場人物`,
    `"${promptInput.workTitle}" 用語`,
  ]).slice(0, Math.max(0, maximumQueries));
  return merged;
}

function prioritizeNativeTitleRecoveryQueries(
  modelQueries: readonly string[],
): string[] {
  const first = modelQueries[0];
  if (!first) return [];
  const inferredTitle = extractQuotedJapaneseTitleCandidates(first)[0];
  if (!inferredTitle) return [...modelQueries];
  const relaxed = first.replace(`"${inferredTitle}"`, inferredTitle);
  return dedupeQueries([first, relaxed, ...modelQueries.slice(1)]);
}

export function buildDeterministicResearchQueries(
  promptInput: WorkContextResearchPromptInput,
): string[] {
  const originalTitles = extractLikelyOriginalTitles(promptInput);
  const verificationCandidates = selectVerificationCandidates(
    promptInput,
    originalTitles,
  );
  const primaryTitle = originalTitles[0] ?? promptInput.workTitle;
  const glossaryAuditQueries = selectGlossaryAuditTerms(promptInput).map(
    (term) => `"${primaryTitle}" "${term}"`,
  );
  const titleTerms = [...primaryTitle.matchAll(/[【《]([^】》]{1,30})[】》]/gu)]
    .flatMap((match) => (match[1] ? [match[1]] : []))
    .slice(0, 2);
  const criticalTerms = dedupeQueries([
    ...titleTerms,
    ...verificationCandidates,
  ]).slice(0, 2);
  const creatorNames = extractCreatorAttributionNames(
    promptInput.selection.text,
  ).slice(0, 3);
  const creatorKeys = new Set(creatorNames.map(normalizeQueryIdentity));
  const roleBoundNames = dedupeQueries([
    ...extractRoleBoundJapaneseNames(promptInput.selection.text),
    ...extractRoleBoundKatakanaNames(promptInput.selection.text),
  ]).filter((name) => !creatorKeys.has(normalizeQueryIdentity(name)));
  const worldTerms = selectWorldVerificationTerms(
    excludeNonWorldVerificationCandidates(promptInput, verificationCandidates),
  );
  const distinctiveRecoveryQuery =
    roleBoundNames.length > 0
      ? [...roleBoundNames.slice(0, 2), ...creatorNames.slice(0, 1)]
          .map((name) => `"${name}"`)
          .join(" ")
      : "";
  const creatorRecoveryQuery =
    creatorNames.length > 0
      ? `${creatorNames
          .slice(0, 2)
          .map((name) => `"${name}"`)
          .join(" ")} 作品`
      : "";
  const distinctiveCreatorRecoveryQuery =
    creatorNames.length > 0 &&
    criticalTerms.length > 0 &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}]/u.test(
      promptInput.workTitle,
    )
      ? `${[criticalTerms[0], ...creatorNames.slice(0, 2)]
          .map((value) => `"${value}"`)
          .join(" ")} 作品`
      : "";
  const latinTitleAnchor = extractLatinTitleSearchAnchor(promptInput.workTitle);
  const latinTitleRecoveryQuery = latinTitleAnchor
    ? `"${latinTitleAnchor}" 原題 日本語 公式`
    : "";
  const latinTitleEvidenceQuery =
    latinTitleAnchor && criticalTerms.length > 0
      ? `"${latinTitleAnchor}" "${criticalTerms[0]}" 作品`
      : "";
  const savedTitleTermQuery =
    criticalTerms.length > 0
      ? `"${promptInput.workTitle}" "${criticalTerms[0]}"`
      : "";
  const secondaryTitles = originalTitles.slice(1, 3);
  const coverageQueries = buildTranslationCriticalCoverageQueries(primaryTitle);
  if (worldTerms.length > 0 && coverageQueries[1]) {
    coverageQueries[1] = `${coverageQueries[1]} ${formatWorldQueryTerms(worldTerms)}`;
  }
  const savedTitleRecoveryQuery =
    needsJapaneseTitleRecovery(promptInput.workTitle) ||
    normalizeQueryIdentity(primaryTitle) !==
      normalizeQueryIdentity(promptInput.workTitle)
      ? `"${promptInput.workTitle}" 原題 公式`
      : "";
  const compactTitle = primaryTitle
    .split(/[!！?？~～〜|｜]/u)[0]
    ?.replace(/\s+/gu, " ")
    .trim();
  const characterTitle =
    compactTitle && normalizeQueryIdentity(compactTitle).length >= 8
      ? compactTitle
      : primaryTitle;
  const characterQueries = [
    coverageQueries[0] ??
      `"${primaryTitle}" 登場人物 キャラクター 主人公 ヒロイン`,
    `"${characterTitle}" 主人公 ヒロイン 登場人物 名前`,
    `"${primaryTitle}" キャラクター紹介 主要人物 名前`,
    `"${characterTitle}" キャラクター 名前 別名 呼び名 仲間 相棒`,
    `"${characterTitle}" 2巻 あらすじ 登場人物 名前`,
    `"${characterTitle}" 最新刊 あらすじ 新キャラクター 名前`,
  ];
  return dedupeQueries([
    `"${primaryTitle}" 公式`,
    savedTitleRecoveryQuery,
    ...characterQueries,
    ...coverageQueries.slice(1, 3),
    ...glossaryAuditQueries.slice(0, 2),
    latinTitleRecoveryQuery,
    latinTitleEvidenceQuery,
    distinctiveRecoveryQuery ? `${distinctiveRecoveryQuery} 作品` : "",
    distinctiveCreatorRecoveryQuery,
    creatorRecoveryQuery,
    savedTitleTermQuery,
    ...glossaryAuditQueries.slice(2, 8),
    ...coverageQueries.slice(3),
    ...(criticalTerms.length > 0
      ? [
          `"${primaryTitle}" ${criticalTerms
            .map((term) => `"${term}"`)
            .join(" ")}`,
        ]
      : []),
    ...secondaryTitles.map((title) => `"${title}" 公式`),
    `"${promptInput.workTitle}" 公式`,
    `"${promptInput.workTitle}" 登場人物`,
    ...verificationCandidates
      .slice(0, 3)
      .map((term) => `"${primaryTitle}" "${term}"`),
    ...glossaryAuditQueries.slice(8),
    ...secondaryTitles.flatMap((title) =>
      buildTranslationCriticalCoverageQueries(title).slice(0, 3),
    ),
    `"${primaryTitle}"`,
  ]);
}

function shouldUseExactTitleMatch(
  query: string,
  promptInput: WorkContextResearchPromptInput,
): boolean {
  if (needsJapaneseTitleRecovery(promptInput.workTitle)) return false;
  const quotedValues = [...query.matchAll(/"([^"\n]{1,240})"/gu)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
  if (quotedValues.length !== 1) return false;
  const expectedTitles = [
    promptInput.workTitle,
    ...extractLikelyOriginalTitles(promptInput),
  ].map(normalizeQueryIdentity);
  return expectedTitles.includes(normalizeQueryIdentity(quotedValues[0] ?? ""));
}

function selectGlossaryAuditTerms(
  promptInput: WorkContextResearchPromptInput,
): string[] {
  const localTextKey = normalizeQueryIdentity(promptInput.selection.text);
  const titleKeys = new Set(
    [promptInput.workTitle, ...extractLikelyOriginalTitles(promptInput)].map(
      normalizeQueryIdentity,
    ),
  );
  return dedupeQueries(
    promptInput.guide.glossary
      .map((entry, index) => {
        const source = selectGlossarySearchAnchor(entry.source, entry.aliases);
        const sourceKey = normalizeQueryIdentity(source);
        let score = entry.origin === "ai" ? 300 : 0;
        if (entry.enabled) score += 80;
        if (!entry.target.trim()) score += 160;
        if (sourceKey && localTextKey.includes(sourceKey)) score += 120;
        return { index, score, source, sourceKey };
      })
      .filter(
        (candidate) =>
          candidate.sourceKey.length >= 2 &&
          !titleKeys.has(candidate.sourceKey),
      )
      .sort(
        (left, right) => right.score - left.score || left.index - right.index,
      )
      .map((candidate) => candidate.source),
  );
}

function selectGlossarySearchAnchor(
  source: string,
  aliases: readonly string[] | undefined,
): string {
  return (
    [source, ...(aliases ?? [])].find((value) =>
      /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value),
    ) ?? source
  )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 80);
}

export function buildRecoveredTitleFollowUpQueries(
  title: string,
  promptInput: WorkContextResearchPromptInput,
): string[] {
  const verificationCandidates = selectVerificationCandidates(
    promptInput,
    extractLikelyOriginalTitles(promptInput),
  );
  const worldTerms = selectWorldVerificationTerms(
    excludeNonWorldVerificationCandidates(promptInput, verificationCandidates),
  );
  const coverageQueries = buildTranslationCriticalCoverageQueries(title);
  return [
    coverageQueries[0] ?? `"${title}" 登場人物 キャラクター 相関図`,
    ...buildFocusedWorldTermQueries(title, worldTerms),
    ...coverageQueries.slice(1),
  ];
}

export function buildEvidenceAnchoredCharacterQueries(
  promptInput: WorkContextResearchPromptInput,
  names: readonly string[],
  trustedTitles: readonly string[] = [],
): string[] {
  const title =
    trustedTitles[0] ??
    extractLikelyOriginalTitles(promptInput)[0] ??
    promptInput.workTitle;
  const compactTitle = title
    .split(/[!！?？~～〜|｜]/u)[0]
    ?.replace(/\s+/gu, " ")
    .trim();
  const titleAnchor =
    compactTitle && normalizeQueryIdentity(compactTitle).length >= 8
      ? compactTitle
      : title;
  const nameAnchors = dedupeQueries([...names])
    .filter((name) => /^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})*$/u.test(name))
    .slice(0, 2);
  if (nameAnchors.length === 0) return [];
  const joinedNames = nameAnchors.map((name) => `"${name}"`).join(" ");
  return [
    `"${titleAnchor}" 2 ${joinedNames} あらすじ`,
    `"${titleAnchor}" 続巻 ${joinedNames} 新キャラクター`,
  ];
}

function buildTranslationCriticalCoverageQueries(title: string): string[] {
  return [
    `"${title}" 登場人物 キャラクター 相関図`,
    `"${title}" 設定 用語 世界観 能力 アイテム`,
    `"${title}" 固有名詞 組織 地名 種族 職業`,
    `"${title}" 称号 階級 システム 通貨 読み方`,
  ];
}

function buildFocusedWorldTermQueries(
  title: string,
  terms: readonly string[],
): string[] {
  const primary = terms[0];
  if (!primary) return [];
  return buildKatakanaSeparatorVariants(primary)
    .slice(0, 3)
    .map((variant) => `"${title}" "${variant}"`);
}

function formatWorldQueryTerms(terms: readonly string[]): string {
  return terms
    .slice(0, 1)
    .map((term, index) => {
      const variants =
        index === 0 ? buildKatakanaSeparatorVariants(term) : [term];
      return variants.length > 1
        ? `(${variants.map((variant) => `"${variant}"`).join(" OR ")})`
        : `"${term}"`;
    })
    .join(" ");
}

function buildKatakanaSeparatorVariants(value: string): string[] {
  if (!/^[ァ-ヺー]{6,14}$/u.test(value)) return [value];
  const characters = [...value];
  const splitPositions = Array.from(
    { length: Math.max(0, characters.length - 3) },
    (_unused, index) => index + 2,
  )
    .sort(
      (left, right) =>
        Math.abs(left - characters.length / 2) -
          Math.abs(right - characters.length / 2) || left - right,
    )
    .slice(0, 4);
  return dedupeQueries([
    value,
    ...splitPositions.map(
      (position) =>
        `${characters.slice(0, position).join("")}・${characters
          .slice(position)
          .join("")}`,
    ),
  ]);
}

function selectVerificationCandidates(
  promptInput: WorkContextResearchPromptInput,
  originalTitles: readonly string[],
): string[] {
  const roleBoundNameKeys = new Set(
    [
      ...extractRoleBoundJapaneseNames(promptInput.selection.text),
      ...extractRoleBoundKatakanaNames(promptInput.selection.text),
    ].map(normalizeQueryIdentity),
  );
  const creatorNameKeys = new Set(
    extractCreatorAttributionNames(promptInput.selection.text).map(
      normalizeQueryIdentity,
    ),
  );
  return extractLocalResearchCandidates(promptInput.selection.text)
    .filter(
      (candidate) =>
        candidate.source.length >= 2 &&
        candidate.source.length <= 40 &&
        countHiragana(candidate.source) < 3 &&
        !isGenericVerificationCandidate(candidate.source) &&
        !isCreatorVerificationCandidate(candidate.source, creatorNameKeys) &&
        !originalTitles.some((title) => {
          const titleKey = title.normalize("NFKC").replace(/\s+/gu, "");
          const sourceKey = candidate.source
            .normalize("NFKC")
            .replace(/\s+/gu, "");
          return titleKey === sourceKey || titleKey.includes(sourceKey);
        }),
    )
    .sort(
      (left, right) =>
        scoreVerificationCandidate(right.source) +
          (roleBoundNameKeys.has(normalizeQueryIdentity(right.source))
            ? 240
            : 0) -
          (scoreVerificationCandidate(left.source) +
            (roleBoundNameKeys.has(normalizeQueryIdentity(left.source))
              ? 240
              : 0)) || right.mentions - left.mentions,
    )
    .map((candidate) => candidate.source)
    .slice(0, 40);
}

function isCreatorVerificationCandidate(
  value: string,
  creatorKeys: ReadonlySet<string>,
): boolean {
  const key = normalizeQueryIdentity(value);
  if (key.length < 3) return false;
  return [...creatorKeys].some(
    (creator) =>
      creator === key || creator.startsWith(key) || creator.endsWith(key),
  );
}

function excludeNonWorldVerificationCandidates(
  promptInput: WorkContextResearchPromptInput,
  candidates: readonly string[],
): string[] {
  const excluded = new Set(
    [
      ...extractCreatorAttributionNames(promptInput.selection.text),
      ...extractRoleBoundJapaneseNames(promptInput.selection.text),
      ...extractRoleBoundKatakanaNames(promptInput.selection.text),
    ].map(normalizeQueryIdentity),
  );
  return candidates.filter(
    (candidate) => !excluded.has(normalizeQueryIdentity(candidate)),
  );
}

function isGenericVerificationCandidate(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, "");
  return (
    /^(?:アニメ|キャラクター|キャラ|コミック|コミックス|マンガ|ライトノベル|ラノベ|ノベル|ストーリー|シリーズ|エピソード|タイトル|サイト|トップ|ホーム|ログイン|ブックマーク|ランキング|レビュー|ポイント|クーポン|セール|キャンペーン|キャスト|スタッフ|ニュース|グッズ|イラスト|メディアミックス|マガジン|ブックス)$/iu.test(
      normalized,
    ) ||
    /^(?:小学校|中学校|高校|大学)?[一二三四五六1-6]年生$/u.test(normalized) ||
    /^.{0,30}(?:ファンタジー|ロマンス|ラブコメ|コメディ|ミステリー|アクション)$/u.test(
      normalized,
    ) ||
    (normalized.length >= 8 &&
      /[ぁ-ん]/u.test(normalized) &&
      /(?:は|が|を|に|へ|で|から|まで|ので|ため|する|した|して|なる|なった)/u.test(
        normalized,
      ))
  );
}

function selectWorldVerificationTerms(candidates: readonly string[]): string[] {
  return candidates
    .filter(
      (candidate) =>
        !/^(?:第)?[0-9０-９一二三四五六七八九十]+(?:話|巻|冊|編)/u.test(
          candidate,
        ) &&
        !/^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(candidate) &&
        !/[様殿嬢君]/u.test(candidate) &&
        !/(?:団長|隊長|部長|社長|博士|先生|騎士|王子|王女|令嬢)[ァ-ヺー]/u.test(
          candidate,
        ) &&
        !/(?:翌日|[話回生人度年月至時])/u.test(candidate) &&
        candidate.length >= 4 &&
        candidate.length <= 24 &&
        !isRepeatedHalf(candidate) &&
        countHiragana(candidate) < 2,
    )
    .sort(
      (left, right) =>
        scoreWorldVerificationTerm(right) - scoreWorldVerificationTerm(left) ||
        right.length - left.length,
    )
    .slice(0, 2);
}

function countHiragana(value: string): number {
  return [...value].filter((character) =>
    /\p{Script=Hiragana}/u.test(character),
  ).length;
}

function isRepeatedHalf(value: string): boolean {
  const characters = [...value];
  if (characters.length < 4 || characters.length % 2 !== 0) return false;
  const middle = characters.length / 2;
  return (
    characters.slice(0, middle).join("") === characters.slice(middle).join("")
  );
}

function scoreWorldVerificationTerm(value: string): number {
  let score = Math.min(value.length, 40);
  if (/[【《][^】》\n]{2,60}[】》]/u.test(value)) score += 160;
  if (
    /^[\p{Script=Han}々〆ヶ]{1,30}[（(][ァ-ヺー・]{2,40}[）)]$/u.test(value)
  ) {
    score += 150;
  }
  if (
    /^[一二三四五六七八九十百千0-9]+(?:大)?[\p{Script=Han}々〆ヶ]{2,12}$/u.test(
      value,
    )
  ) {
    score += 120;
  }
  if (/[\p{Script=Han}々〆ヶ]/u.test(value)) score += 70;
  if (/^[ァ-ヺー]{6,24}$/u.test(value)) score += 160;
  return score;
}

function scoreVerificationCandidate(value: string): number {
  let score = Math.min(value.length, 40);
  if (/^(?:第)?[0-9０-９一二三四五六七八九十]+(?:話|巻|冊|編)/u.test(value)) {
    return -1_000;
  }
  if (/^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(value)) score += 120;
  else if (/^[ァ-ヺー]{3,24}(?:様|殿)?$/u.test(value)) score += 50;
  if (/^[\p{Script=Han}々〆ヶ]{1,30}[（(][ァ-ヺー・]{2,40}[）)]$/u.test(value))
    score += 110;
  if (
    /^[一二三四五六七八九十百千0-9]+(?:大)?[\p{Script=Han}々〆ヶ]{2,12}$/u.test(
      value,
    )
  )
    score += /^[一二三四五六七八九十百千0-9]+大/u.test(value) ? 70 : 20;
  if (/[【《][^】》\n]{2,60}[】》]/u.test(value)) score += 90;
  if (
    value.length <= 32 &&
    /[ァ-ヺー]{2,}/u.test(value) &&
    /[\p{Script=Han}々〆ヶ]/u.test(value)
  )
    score += 70;
  return score;
}

async function parseOrRepairResearchResponse(
  rawText: string,
  endpoint: ModelEndpointHandle,
  options: Awaited<ReturnType<typeof buildTavilyAnalysisOptions>>,
  maxOutputTokens: number,
): Promise<unknown> {
  try {
    return parseWorkContextModelJson(rawText);
  } catch (_error) {
    const prompt = buildResearchJsonRepairPrompt(rawText);
    const repaired = await requestWorkContextAnalysisText({
      endpoint,
      options,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens,
    });
    return parseWorkContextModelJson(repaired);
  }
}

function dedupeQueries(values: string[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const query = value.replace(/\s+/g, " ").trim().slice(0, 400);
    const key = query.normalize("NFKC").toLocaleLowerCase();
    if (!query || seen.has(key)) return [];
    seen.add(key);
    return [query];
  });
}

function isTavilyQuotaError(error: unknown): boolean {
  const status = (error as { httpStatus?: unknown } | null)?.httpStatus;
  return status === 432 || status === 433;
}
