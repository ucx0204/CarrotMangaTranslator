/* eslint-disable complexity, max-depth, max-lines, max-lines-per-function -- evidence enrichment is a fail-closed trust boundary whose independent rejection signals remain explicit and auditable */
import type { TavilySearchResponse } from "./tavilyClient";
import {
  extractCreatorAttributionNames,
  extractExplicitNamedTerms,
  extractLocalResearchCandidates,
  extractRoleBoundJapaneseNames,
  extractRoleBoundKatakanaNames,
  findMissingCriticalEvidenceCandidates,
  hasExplicitTranslationCriticalTermEvidence,
  isGenericResearchEntityWord,
  isLowRelevanceListingUrl,
  isResearchResultBoundToWork,
  type LocalResearchCandidate,
  type WorkContextResearchPromptInput,
} from "./workContextResearchPrompt";
import {
  extractLatinTitleSearchAnchor,
  extractLikelyOriginalTitles,
  needsJapaneseTitleRecovery,
  titleIdentitySimilarity,
} from "./workContextResearchTitles";

type JsonRecord = Record<string, unknown>;

type OfficialNameEvidence = {
  name: string;
  sources: Array<{ title: string; url: string }>;
  authoritySignal: boolean;
};

type EvidenceWorkTitle = {
  title: string;
  score: number;
  sources: Array<{ title: string; url: string }>;
};

type WorkBoundResult = {
  query: string;
  result: TavilySearchResponse["results"][number];
};

type ResearchEvidenceCache = {
  input: WorkContextResearchPromptInput;
  searches: readonly TavilySearchResponse[];
  normalizedSelectionText?: string;
  creatorNames?: string[];
  localCandidates?: LocalResearchCandidate[];
  roleBoundLocalNames?: string[];
  likelyOriginalTitles?: string[];
  trustedEvidenceTitles?: string[];
  evidenceWorkTitles?: EvidenceWorkTitle[];
  workBoundResults?: WorkBoundResult[];
  primaryTexts: WeakMap<object, string>;
  normalizedPrimaryTexts: WeakMap<object, string>;
  resultBindings: WeakMap<object, Map<string, boolean>>;
};

let activeEvidenceCache: ResearchEvidenceCache | null = null;

function withResearchEvidenceCache<T>(
  input: WorkContextResearchPromptInput,
  searches: readonly TavilySearchResponse[],
  action: () => T,
): T {
  if (
    activeEvidenceCache?.input === input &&
    activeEvidenceCache.searches === searches
  ) {
    return action();
  }
  const previous = activeEvidenceCache;
  activeEvidenceCache = {
    input,
    searches,
    primaryTexts: new WeakMap<object, string>(),
    normalizedPrimaryTexts: new WeakMap<object, string>(),
    resultBindings: new WeakMap<object, Map<string, boolean>>(),
  };
  try {
    return action();
  } finally {
    activeEvidenceCache = previous;
  }
}

function getActiveCache(
  input: WorkContextResearchPromptInput,
  searches?: readonly TavilySearchResponse[],
): ResearchEvidenceCache | null {
  const matches =
    activeEvidenceCache?.input === input &&
    (searches === undefined || activeEvidenceCache.searches === searches);
  return matches ? activeEvidenceCache : null;
}

function cachedNormalizedSelectionText(
  input: WorkContextResearchPromptInput,
): string {
  const cache = getActiveCache(input);
  if (!cache) {
    return normalizeLooseEvidenceKey(input.selection.text);
  }
  cache.normalizedSelectionText ??= normalizeLooseEvidenceKey(
    input.selection.text,
  );
  return cache.normalizedSelectionText;
}

function cachedCreatorNames(input: WorkContextResearchPromptInput): string[] {
  const cache = getActiveCache(input);
  if (!cache) {
    return extractCreatorAttributionNames(input.selection.text);
  }
  cache.creatorNames ??= extractCreatorAttributionNames(input.selection.text);
  return cache.creatorNames;
}

function cachedLocalCandidates(
  input: WorkContextResearchPromptInput,
): LocalResearchCandidate[] {
  const cache = getActiveCache(input);
  if (!cache) {
    return extractLocalResearchCandidates(input.selection.text);
  }
  cache.localCandidates ??= extractLocalResearchCandidates(
    input.selection.text,
  );
  return cache.localCandidates;
}

function cachedRoleBoundLocalNames(
  input: WorkContextResearchPromptInput,
): string[] {
  const cache = getActiveCache(input);
  if (!cache) {
    return extractRoleBoundJapaneseNames(input.selection.text);
  }
  cache.roleBoundLocalNames ??= extractRoleBoundJapaneseNames(
    input.selection.text,
  );
  return cache.roleBoundLocalNames;
}

function cachedLikelyOriginalTitles(
  input: WorkContextResearchPromptInput,
): string[] {
  const cache = getActiveCache(input);
  if (!cache) return extractLikelyOriginalTitles(input);
  cache.likelyOriginalTitles ??= extractLikelyOriginalTitles(input);
  return cache.likelyOriginalTitles;
}

function cachedTrustedEvidenceTitles(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): string[] {
  const cache = getActiveCache(input, searches);
  if (!cache) {
    return extractTrustedEvidenceTitles(searches, input);
  }
  cache.trustedEvidenceTitles ??= extractTrustedEvidenceTitlesCached(
    searches,
    input,
  );
  return cache.trustedEvidenceTitles;
}

function cachedEvidenceWorkTitles(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): EvidenceWorkTitle[] {
  const cache = getActiveCache(input, searches);
  if (!cache) {
    return collectEvidenceWorkTitles(searches, input);
  }
  cache.evidenceWorkTitles ??= collectEvidenceWorkTitles(searches, input);
  return cache.evidenceWorkTitles;
}

function cachedWorkBoundResults(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): WorkBoundResult[] {
  const cache = getActiveCache(input, searches);
  if (!cache) {
    return collectWorkBoundResults(searches, input);
  }
  cache.workBoundResults ??= collectWorkBoundResults(searches, input);
  return cache.workBoundResults;
}

export function mergeResearchResults(
  initial: unknown,
  audited: unknown,
): unknown {
  const initialRoot = readRecord(initial);
  const auditedRoot = readRecord(audited);
  if (!initialRoot || !auditedRoot) return audited;
  const operations = new Map<string, unknown>();
  for (const value of [
    ...(Array.isArray(initialRoot.operations) ? initialRoot.operations : []),
    ...(Array.isArray(auditedRoot.operations) ? auditedRoot.operations : []),
  ]) {
    const operation = readRecord(value);
    if (!operation) continue;
    operations.set(operationIdentity(operation), value);
  }
  const warnings = [
    ...(Array.isArray(initialRoot.warnings) ? initialRoot.warnings : []),
    ...(Array.isArray(auditedRoot.warnings) ? auditedRoot.warnings : []),
  ];
  return { ...auditedRoot, operations: [...operations.values()], warnings };
}

export function enrichResearchResultFromEvidence(
  raw: unknown,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): unknown {
  return withResearchEvidenceCache(input, searches, () =>
    enrichResearchResultFromEvidenceCached(raw, searches, input),
  );
}

function enrichResearchResultFromEvidenceCached(
  raw: unknown,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): unknown {
  const root = readRecord(raw);
  if (!root || !Array.isArray(root.operations)) return raw;
  const readings = collectEvidenceReadings(searches, input);
  const officialNames = collectOfficialKatakanaNames(searches, input);
  const enriched = root.operations.map((value) => {
    const operation = convertEvidenceBackedCharacterGlossaryOperation(
      convertMisclassifiedCharacterGlossaryOperation(readRecord(value)),
      input,
      searches,
    );
    if (operation?.entity === "character") {
      return enrichCharacterSpelling(operation, officialNames, searches);
    }
    if (operation?.entity !== "glossary") return value;
    return enrichGlossaryOperation(operation, readings, input, searches);
  });
  const baseOperations = [
    ...enriched,
    ...buildMissingOfficialSpellingCorrections(
      enriched,
      input.guide,
      officialNames,
    ),
  ];
  const completedOperations = [
    ...baseOperations,
    ...buildObviousGenericCharacterDisableSuggestions(
      baseOperations,
      input.guide,
    ),
    ...buildMissingCriticalEvidenceOperations(baseOperations, searches, input),
  ];
  const verifiedOperations = completedOperations.map((operation) =>
    bindOperationSourcesToWork(operation, searches, input),
  );
  const usefulOperations = verifiedOperations.filter((operation) =>
    keepUsefulResearchOperation(operation, input, searches),
  );
  const dedupedOperations = dedupeEvidenceOperations(
    usefulOperations,
    searches,
    input,
  );
  return {
    ...root,
    operations: dedupedOperations.map((operation) =>
      finalizeEvidenceOperation(operation, searches, input),
    ),
  };
}

function bindOperationSourcesToWork(
  value: unknown,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): unknown {
  const operation = readRecord(value);
  if (!operation || operation.action === "disable") return value;
  const candidates =
    operation.entity === "character"
      ? [
          ...(Array.isArray(operation.sourceNames)
            ? operation.sourceNames.filter(
                (name): name is string => typeof name === "string",
              )
            : []),
          ...readSourceAliases(operation.aliases),
        ]
      : operation.entity === "glossary" && typeof operation.source === "string"
        ? [operation.source, ...readSourceAliases(operation.aliases)]
        : [];
  const sources = mergeRawSources(
    [],
    candidates.flatMap((candidate) =>
      findWorkBoundTextEvidenceSources(candidate, searches, input),
    ),
  ).slice(0, 3);
  return { ...operation, sources };
}

function convertEvidenceBackedCharacterGlossaryOperation(
  operation: JsonRecord | null,
  input: WorkContextResearchPromptInput,
  searches: readonly TavilySearchResponse[],
): JsonRecord | null {
  if (
    operation?.entity !== "glossary" ||
    operation.action !== "add" ||
    operation.category === "other"
  ) {
    return operation;
  }
  const source = typeof operation.source === "string" ? operation.source : "";
  const target = typeof operation.target === "string" ? operation.target : "";
  if (
    !/^[ァ-ヺー]{3,20}$/u.test(source) ||
    !/\p{Script=Hangul}/u.test(target) ||
    !hasWorkBoundCharacterEvidence(source, searches, input)
  ) {
    return operation;
  }
  return {
    ...operation,
    entity: "character",
    source: null,
    target: null,
    category: null,
    sourceNames: dedupeText([source, ...readSourceAliases(operation.aliases)]),
    targetName: target,
    displayName: target,
    aliases: [],
  };
}

function finalizeEvidenceOperation(
  value: unknown,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): unknown {
  const operation = readRecord(value);
  if (
    operation?.entity !== "glossary" ||
    typeof operation.source !== "string"
  ) {
    return value;
  }
  const sourceWithoutCreator = stripKnownCreatorTitleSuffix(
    operation.source,
    input,
  );
  const sourceWithoutPublicationSuffix =
    stripCorroboratedParentheticalTitleSuffix(operation.source, searches);
  const embeddedTitle = extractEmbeddedEvidenceTitle(
    operation.source,
    searches,
  );
  const canonicalTitle = embeddedTitle
    ? {
        title: embeddedTitle,
        sources: findTextEvidenceSources(embeddedTitle, searches),
      }
    : sourceWithoutCreator !== operation.source &&
        findTextEvidenceSources(sourceWithoutCreator, searches).length > 0
      ? {
          title: sourceWithoutCreator,
          sources: findTextEvidenceSources(sourceWithoutCreator, searches),
        }
      : sourceWithoutPublicationSuffix !== operation.source
        ? {
            title: sourceWithoutPublicationSuffix,
            sources: findTextEvidenceSources(
              sourceWithoutPublicationSuffix,
              searches,
            ),
          }
        : isQuotedPublicationTitleSource(operation.source, searches)
          ? {
              title: operation.source,
              sources: findTextEvidenceSources(operation.source, searches),
            }
          : isResearchWorkTitleSource(operation.source, input, searches)
            ? findCanonicalEvidenceTitle(operation.source, searches, input)
            : null;
  if (!canonicalTitle) return operation;
  return {
    ...operation,
    source: canonicalTitle.title,
    category: "other",
    criticalTitleTranslation: true,
    sources: mergeRawSources(operation.sources, canonicalTitle.sources),
  };
}

function convertMisclassifiedCharacterGlossaryOperation(
  operation: JsonRecord | null,
): JsonRecord | null {
  if (
    operation?.entity !== "glossary" ||
    operation.action !== "add" ||
    operation.category !== "character"
  ) {
    return operation;
  }
  const source = typeof operation.source === "string" ? operation.source : "";
  const target = typeof operation.target === "string" ? operation.target : "";
  if (
    !source ||
    source.length > 40 ||
    !hasJapaneseScript(source) ||
    !/\p{Script=Hangul}/u.test(target) ||
    looksLikeSentenceGlossarySource(source) ||
    looksLikeWebPageMetadata(source)
  ) {
    return operation;
  }
  return {
    ...operation,
    entity: "character",
    source: null,
    target: null,
    category: null,
    sourceNames: dedupeText([source, ...readSourceAliases(operation.aliases)]),
    targetName: target,
    displayName: target,
    aliases: [],
    speechStyle: "neutral",
    customSpeechStyle: null,
  };
}

function keepUsefulResearchOperation(
  value: unknown,
  input: WorkContextResearchPromptInput,
  searches: readonly TavilySearchResponse[],
): boolean {
  const operation = readRecord(value);
  if (!operation) return false;
  if (operation.action === "disable") return true;
  if (operation.action !== "add" && operation.action !== "update") return false;
  if (hasUntranslatedJapaneseTarget(operation)) return false;
  if (hasIncompleteCharacterTarget(operation)) return false;
  if (!hasSearchBackedSource(operation.sources, searches)) return false;
  if (operation.entity === "character") {
    return keepUsefulCharacterOperation(operation, input, searches);
  }
  if (operation.entity !== "glossary") return true;
  const source = typeof operation.source === "string" ? operation.source : "";
  if (!source || /\p{Script=Hangul}/u.test(source)) return false;
  if (normalizeLooseEvidenceKey(source).length < 2) return false;
  if (/^[^\p{L}\p{N}「『【《（(\u005b]+(?=[぀-ヿ㐀-鿿])/u.test(source)) {
    return false;
  }
  if (looksLikeRoleDecoratedCharacterTerm(source)) return false;
  if (isCreatorCreditTerm(source, searches, input)) return false;
  if (isResearchWorkTitleSource(source, input, searches)) {
    return false;
  }
  if (looksLikeWebPageMetadata(source)) return false;
  if (looksLikeGenericKatakanaWebWord(source)) return false;
  if (looksLikeGenericDictionaryTerm(source)) return false;
  if (looksLikeSentenceGlossarySource(source)) return false;
  if (isLocallyTruncatedJapaneseTerm(source, input)) return false;
  if (isOnlyWorkTitleFragment(source, searches, input)) return false;
  const aliases = readSourceAliases(operation.aliases);
  if (rawSourcesAreOnlySocial(operation.sources)) return false;
  const candidates = [source, ...aliases];
  const supportedCandidate = candidates.find(
    (candidate) =>
      hasStrongWorkBoundTextEvidence(candidate, searches, input) ||
      hasExplicitTerminologyEvidence(candidate, searches, input),
  );
  if (!supportedCandidate) return false;
  const localText = cachedNormalizedSelectionText(input);
  const localMentions = Math.max(
    0,
    ...candidates.map((candidate) =>
      countNormalizedOccurrences(
        localText,
        normalizeLooseEvidenceKey(candidate),
      ),
    ),
  );
  const signals = collectStrongWorkBoundEvidenceSignals(
    supportedCandidate,
    searches,
    input,
  );
  const explicitTermEvidence = candidates.some((candidate) =>
    hasExplicitTerminologyEvidence(candidate, searches, input),
  );
  if (
    operation.action === "add" &&
    localMentions === 0 &&
    !explicitTermEvidence
  ) {
    return false;
  }
  if (operation.criticalEvidenceTranslation === true) return true;
  const distinctiveShape = candidates.some(looksLikeDistinctiveTermShape);
  return (
    explicitTermEvidence ||
    (aliases.length > 0 && (localMentions > 0 || signals.hosts.size >= 2)) ||
    (distinctiveShape &&
      (localMentions >= 2 ||
        signals.hosts.size >= 2 ||
        (localMentions >= 1 && signals.hasDirectOrOfficialSource)))
  );
}

function isCreatorCreditTerm(
  source: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  if (!source || source.length > 40) return false;
  const sourceKey = normalizeLooseEvidenceKey(source);
  const knownCreators = cachedCreatorNames(input);
  if (
    knownCreators.some(
      (creator) => normalizeLooseEvidenceKey(creator) === sourceKey,
    )
  ) {
    return true;
  }
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const creatorBefore = new RegExp(
    `(?:キャラクター原案|原作|作画|漫画|著者|作者|原案|脚本|構成|イラストレーター|イラスト|絵)[\\s·・:：／/]{0,8}${escaped}(?=(?:\\s|[、。／/|]|$))`,
    "u",
  );
  const creatorAfter = new RegExp(
    `${escaped}[\\s·・:：／/]{0,8}(?:[（(]\\s*)?(?:著|作(?!品)|原作|作画|漫画|著者|作者|原案|脚本|構成|イラストレーター|イラスト|絵)(?:\\s*[）)])?`,
    "u",
  );
  const englishCreatorBefore = new RegExp(
    `(?:story|art|author|artist|original(?:\\s+creator)?|illustration|illustrator)\\s*[:：-]\\s*${escaped}(?=(?:\\s|[,;/|]|$))`,
    "iu",
  );
  const englishCreatorAfter = new RegExp(
    `${escaped}\\s*(?:[（(][^）)]*(?:story|art|author|artist|original|illustration|illustrator)[^）)]*[）)]|[-–—:：]\\s*(?:story|art|author|artist|original|illustration|illustrator))`,
    "iu",
  );
  return searches.some((search) =>
    search.results.some((result) =>
      [result.title, result.content].some(
        (text) =>
          creatorBefore.test(text) ||
          creatorAfter.test(text) ||
          englishCreatorBefore.test(text) ||
          englishCreatorAfter.test(text) ||
          knownCreators.some((creator) =>
            hasCreatorAliasContext(source, creator, text),
          ),
      ),
    ),
  );
}

function hasCreatorAliasContext(
  source: string,
  knownCreator: string,
  text: string,
): boolean {
  const sourceKey = normalizeLooseEvidenceKey(source);
  const creatorKey = normalizeLooseEvidenceKey(knownCreator);
  const textKey = normalizeLooseEvidenceKey(text);
  if (
    sourceKey.length < 3 ||
    creatorKey.length < 3 ||
    sourceKey === creatorKey ||
    !textKey.includes(sourceKey) ||
    !textKey.includes(creatorKey)
  ) {
    return false;
  }
  const sourceIndex = textKey.indexOf(sourceKey);
  const creatorIndex = textKey.indexOf(creatorKey);
  if (Math.abs(sourceIndex - creatorIndex) > 120) return false;
  return /(?:キャラクター原案|原作|作画|漫画|著者|作者|原案|脚本|構成|イラストレーター|イラスト|story|art|author|artist|original|illustrat)/iu.test(
    text,
  );
}

function hasUntranslatedJapaneseTarget(operation: JsonRecord): boolean {
  if (operation.entity === "glossary") {
    const source = typeof operation.source === "string" ? operation.source : "";
    const target = typeof operation.target === "string" ? operation.target : "";
    return (
      hasJapaneseScript(source) &&
      target.length > 0 &&
      (!/\p{Script=Hangul}/u.test(target) || hasJapaneseScript(target))
    );
  }
  if (operation.entity !== "character") return false;
  const sourceNames = Array.isArray(operation.sourceNames)
    ? operation.sourceNames.filter(
        (name): name is string => typeof name === "string",
      )
    : [];
  const target =
    typeof operation.targetName === "string" ? operation.targetName : "";
  return (
    sourceNames.some(hasJapaneseScript) &&
    target.length > 0 &&
    (!/\p{Script=Hangul}/u.test(target) || hasJapaneseScript(target))
  );
}

function hasIncompleteCharacterTarget(operation: JsonRecord): boolean {
  if (operation.entity !== "character") return false;
  const sourceNames = Array.isArray(operation.sourceNames)
    ? operation.sourceNames.filter(
        (name): name is string => typeof name === "string",
      )
    : [];
  const target =
    typeof operation.targetName === "string" ? operation.targetName : "";
  return sourceNames.some((source) => {
    if (!/^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(source)) return false;
    return (
      source.split("・").filter(Boolean).length >
      target.split(/\s+/u).filter(Boolean).length
    );
  });
}

function hasJapaneseScript(value: string): boolean {
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(value);
}

function hasSearchBackedSource(
  value: unknown,
  searches: readonly TavilySearchResponse[],
): boolean {
  if (!Array.isArray(value)) return false;
  const allowed = new Set(
    searches
      .flatMap((search) => search.results)
      .map((result) => normalizeEvidenceUrl(result.url))
      .filter(Boolean),
  );
  return value.some((candidate) => {
    const source = readRecord(candidate);
    return (
      typeof source?.url === "string" &&
      allowed.has(normalizeEvidenceUrl(source.url))
    );
  });
}

function normalizeEvidenceUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    url.hash = "";
    return url.href.replace(/\/$/u, "");
  } catch (_error) {
    return "";
  }
}

function looksLikeWebPageMetadata(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, "");
  return (
    /(?:無料|クーポン|セール|ランキング|ブックマーク|ホーム|ログイン|会員|発売|配信|放送|連載|更新|月号|価格|税込|試し読み|ジャンル|コミカライズ|コミックス|レーベル|レビュー|考察|ネタバレ|感想|ポイント|タグ|エピソード|イメージ画像|おすすめ|作品一覧|書籍一覧|作品・書籍|著者ページ|作者ページ|公式サイト|キャラクター原案|アニメ化|アニメ公式|(?:受賞|ノミネート)(?:作|作品)|(?:コンテスト|大賞|グランプリ)受賞)/u.test(
      normalized,
    ) ||
    /^(?:(?:第)?[一二三四五六七八九十百千0-9０-９]+(?:話|巻|章|回|頁|ページ)|一覧|目次|作品|書籍|検索|続きを読む|販売|配信|巻読)$/u.test(
      normalized,
    )
  );
}

function looksLikeGenericKatakanaWebWord(value: string): boolean {
  return (
    isGenericResearchEntityWord(value) ||
    /^(?:スカッ(?:と)?|胸キュン|ざまぁ?|チート級?|爽快|痛快)$/u.test(value) ||
    /^(?:アニメ|キャラクター|キャラ|コミック|コミックス|マンガ|ライトノベル|ラノベ|ノベル|ストーリー|シリーズ|エピソード|タイトル|サイト|トップ|ホーム|ログイン|ブックマーク|ランキング|レビュー|ポイント|クーポン|セール|キャンペーン|キャスト|スタッフ|ニュース|グッズ|イラスト|メディアミックス|マガジン|ブックス)$/iu.test(
      value,
    ) ||
    /^(?:月刊|週刊|隔月刊)(?:少年|少女|青年)?[ァ-ヺー]{2,}(?:コミック|コミックス)?$/u.test(
      value,
    ) ||
    /^(?:コミック|コミックス|マンガ).{2,}$/u.test(value) ||
    /^(?:月刊|週刊|隔月刊).{2,}$/u.test(value) ||
    /^(?:.{2,})(?:編集部|コミックス|文庫|出版|書房|マガジン)$/u.test(value)
  );
}

function looksLikeSentenceGlossarySource(value: string): boolean {
  return (
    value.length > 24 ||
    (value.length >= 8 && /[はがを]/u.test(value) && /[ぁ-ん]/u.test(value)) ||
    (value.length >= 6 &&
      /[ぁ-ん]/u.test(value) &&
      /(?:じゃ|なきゃ|なくちゃ|ない|ません|です|ます|だ|ダメだ)$/u.test(
        value,
      )) ||
    (value.length > 14 &&
      /(?:は|が|を|に|へ|で|から|まで|ので|ため|でき|する|した|して|なる|なった|可能|入手|開け|解除)/u.test(
        value,
      ))
  );
}

function looksLikeRoleDecoratedCharacterTerm(value: string): boolean {
  return (
    /^(?:.{1,20}の)?(?:美少女)?(?:悪女|執事|幼馴染|英雄|令嬢|騎士|冒険者|魔術師|剣聖|メイド|教師|学生|ヒロイン|隊長|団長)[・･][ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})*$/u.test(
      value,
    ) ||
    /^(?:(?:第[一二三四五六七八九十百0-9０-９]+)?(?:王女|王子|皇女|皇子|姫|公爵令嬢)|妻|夫|娘|息子|父|母|姉|妹|兄|弟|婚約者|相棒)[・･\s]*[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})*$/u.test(
      value,
    ) ||
    /^(?:イケオジ|美少女|美少年|謎の|最強|最弱|悪役|嫌われ|冷酷|没落|辺境)(?:公爵|侯爵|伯爵|子爵|男爵|令嬢|王子|王女|皇子|皇女|騎士|冒険者|魔術師|剣士|勇者|聖女)$/u.test(
      value,
    ) ||
    stripCharacterRolePrefix(value) !== value
  );
}

function looksLikeGenericDictionaryTerm(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .replace(/\s+/gu, "")
    .replace(/^[「『【《（(\u005b]+|[」』】》）)\]]+$/gu, "");
  return (
    /^(?:第)?[一二三四五六七八九十百千万億兆0-9０-９]+(?:年(?:前|後)?|歳|才|日|月|週|時間|分|秒|人|名|個|本|冊|巻|話|回|階|章|度|回目)$/u.test(
      normalized,
    ) ||
    /^(?:小学校|中学校|高校|大学)?[一二三四五六1-6]年生$/u.test(normalized) ||
    /^(?:(?:最強|最弱|悪役|嫌われ|冷酷|没落|辺境|美少女)?(?:主人公|貴族|悪女|執事|幼馴染|少年|少女|青年|娘|息子|父|母|姉|妹|兄|弟|神|女神|英雄|王|王子|王女|皇子|皇女|皇帝|令嬢|騎士|冒険者|魔術師|剣聖|メイド|教師|学生|友人|仲間|ヒロイン|隊長|団長|部長|社長|博士)|おっさん|おじさん|おばさん|老人|老女|男|女|家族|会社員|OL)$/iu.test(
      normalized,
    ) ||
    /^(?:(?:最強|最弱|悪役|敵|味方|主人公|ヒロイン|モブ|サブ|主要|登場|攻略対象|ライバル)?(?:キャラ|キャラクター))$/u.test(
      normalized,
    ) ||
    /^[ァ-ヺーA-Za-z]{2,}(?:生活|体験|経験|知識|人生)$/u.test(normalized) ||
    /^[ァ-ヺー]{2,}(?:ライフ|ライフスタイル|ストーリー)$/u.test(normalized) ||
    /^(?:史上|歴代)(?:最強|最弱|最悪|最高|最低)の.{1,20}$/u.test(normalized) ||
    /^.{0,30}(?:ファンタジー|ラブコメ|ロマンス|コメディ|ミステリー|アクション)$/u.test(
      normalized,
    ) ||
    /^(?:一切|全く|まったく|全然)(?:興味|関心|関係|必要|問題|意味|価値|理由|余裕|心配)(?:なし|ない)?$/u.test(
      normalized,
    )
  );
}

function isLocallyTruncatedJapaneseTerm(
  value: string,
  input: WorkContextResearchPromptInput,
): boolean {
  const candidate = value.normalize("NFKC").trim();
  if (
    candidate.length < 3 ||
    /\s/u.test(candidate) ||
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(candidate)
  ) {
    return false;
  }
  const localText = input.selection.text.normalize("NFKC");
  const lastCharacter = [...candidate].at(-1) ?? "";
  if (!/\p{Script=Han}/u.test(lastCharacter)) return false;
  let cursor = 0;
  let foundFragment = false;
  while (cursor < localText.length) {
    const index = localText.indexOf(candidate, cursor);
    if (index < 0) break;
    const after = localText[index + candidate.length] ?? "";
    const endsInsideInflection =
      /\p{Script=Hiragana}/u.test(after) &&
      !/[はがをにへとでのもやかねよぞさしだ]/u.test(after);
    if (!endsInsideInflection) return false;
    foundFragment = true;
    cursor = index + Math.max(1, candidate.length);
  }
  return foundFragment;
}

function looksLikeDistinctiveTermShape(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, "");
  return (
    /^[\p{Script=Han}々〆ヶ]{1,30}[（(][ァ-ヺー・]{2,40}[）)]$/u.test(
      normalized,
    ) ||
    /^[一二三四五六七八九十百千0-9]+(?:大)?[\p{Script=Han}々〆ヶ]{2,12}$/u.test(
      normalized,
    ) ||
    /^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(normalized) ||
    /[【《「『][^】》」』\n]{2,60}[】》」』]/u.test(normalized) ||
    /^[ァ-ヺー]{6,24}$/u.test(normalized) ||
    /^[A-Za-z][A-Za-z0-9]*(?:[・･·:_-][A-Za-z][A-Za-z0-9]*)+$/u.test(
      normalized,
    ) ||
    (/[ァ-ヺー]{2,}/u.test(normalized) &&
      /[\p{Script=Han}々〆ヶ]{1,}/u.test(normalized)) ||
    /^[A-Z][A-Z0-9]{1,7}$/u.test(normalized)
  );
}

function isOnlyWorkTitleFragment(
  value: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  const valueKey = normalizeLooseEvidenceKey(value);
  if (valueKey.length < 3 || isLocallyQuotedTerm(value, input)) return false;
  const titleKeys = dedupeText([
    input.workTitle,
    ...cachedLikelyOriginalTitles(input),
    ...cachedTrustedEvidenceTitles(searches, input),
    ...cachedEvidenceWorkTitles(searches, input).map(
      (candidate) => candidate.title,
    ),
  ])
    .map(normalizeLooseEvidenceKey)
    .filter((titleKey) => titleKey.length > valueKey.length);
  if (!titleKeys.some((titleKey) => titleKey.includes(valueKey))) return false;
  if (hasExplicitTerminologyEvidence(value, searches, input)) return false;
  let localRemainder = cachedNormalizedSelectionText(input);
  for (const titleKey of titleKeys) {
    localRemainder = localRemainder.replaceAll(titleKey, "");
  }
  return countNormalizedOccurrences(localRemainder, valueKey) < 2;
}

function hasStrongWorkBoundTextEvidence(
  value: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  const signals = collectStrongWorkBoundEvidenceSignals(value, searches, input);
  return signals.hasDirectOrOfficialSource || signals.hosts.size >= 2;
}

function collectStrongWorkBoundEvidenceSignals(
  value: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): { hosts: Set<string>; hasDirectOrOfficialSource: boolean } {
  const valueKey = normalizeLooseEvidenceKey(value);
  if (!valueKey) {
    return { hosts: new Set<string>(), hasDirectOrOfficialSource: false };
  }
  const hosts = new Set<string>();
  let hasDirectOrOfficialSource = false;
  for (const search of searches) {
    for (const result of search.results) {
      const text = primaryResearchEvidenceText(result);
      const textKey = normalizeLooseEvidenceKey(text);
      if (
        !textKey.includes(valueKey) ||
        !isWorkBoundSearchResult(result, search.query, searches, input)
      ) {
        continue;
      }
      try {
        const host = new URL(result.url).hostname.replace(/^www\./iu, "");
        if (isSocialEvidenceHost(host)) continue;
        hosts.add(host);
      } catch (_error) {
        continue;
      }
      hasDirectOrOfficialSource ||=
        hasDirectWorkPagePath(result.url) ||
        /(?:公式|official)/iu.test(result.title);
    }
  }
  return { hosts, hasDirectOrOfficialSource };
}

function hasExplicitTerminologyEvidence(
  value: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  if (!value) return false;
  if (isLocallyQuotedTerm(value, input)) return true;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const explicitTerm = new RegExp(
    `[「『【《]${escaped}[」』】》]|${escaped}[（(][ァ-ヺー・]{2,40}[）)]|${escaped}(?:とは|という|と呼ばれ|の名称|の名)|(?:用語|固有名詞|能力名|技能名|組織名|地名|称号)[^。！？\\n]{0,40}${escaped}`,
    "u",
  );
  return searches.some((search) =>
    search.results.some((result) => {
      const text = primaryResearchEvidenceText(result);
      if (!isWorkBoundSearchResult(result, search.query, searches, input)) {
        return false;
      }
      if (
        !explicitTerm.test(text) &&
        !hasExplicitTranslationCriticalTermEvidence(value, text)
      ) {
        return false;
      }
      const occurrence = text.indexOf(value);
      if (occurrence >= 0) {
        const nearby = text.slice(
          Math.max(0, occurrence - 40),
          occurrence + value.length + 80,
        );
        if (
          /(?:一般|普通|汎用|俗語|単なる|一般表現|一般用語|固有名詞ではない)/u.test(
            nearby,
          )
        ) {
          return false;
        }
      }
      return true;
    }),
  );
}

function parseEvidenceHost(value: string): string | null {
  try {
    return new URL(value).hostname.replace(/^www\./iu, "");
  } catch (_error) {
    return null;
  }
}

function isSocialEvidenceHost(value: string): boolean {
  return /^(?:x\.com|twitter\.com|bsky\.app|facebook\.com|instagram\.com|youtube\.com|youtu\.be)$/iu.test(
    value,
  );
}

function keepUsefulCharacterOperation(
  operation: JsonRecord,
  input: WorkContextResearchPromptInput,
  searches: readonly TavilySearchResponse[],
): boolean {
  const names = Array.isArray(operation.sourceNames)
    ? operation.sourceNames.filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      )
    : [];
  if (names.length === 0) return false;
  if (names.some((name) => stripCharacterRolePrefix(name) !== name)) {
    return false;
  }
  if (names.some((name) => /\p{Script=Hangul}/u.test(name))) {
    return false;
  }
  if (
    names.every(
      (name) =>
        looksLikeGenericCharacterLabel(name) ||
        looksLikeGenericKatakanaWebWord(name),
    )
  ) {
    return false;
  }
  if (
    names.some((name) => !hasCompatibleKatakanaTargetInitial(name, operation))
  ) {
    return false;
  }
  if (
    names.some((name) => {
      const parts = name.split(/[・･]/u).filter(Boolean);
      return parts.length > 1 && parts.every(looksLikeGenericKatakanaWebWord);
    })
  ) {
    return false;
  }
  if (names.some((name) => isResearchWorkTitleSource(name, input, searches))) {
    return false;
  }
  if (
    names.every((name) => isPublicationNameFragment(name, searches)) &&
    !names.some((name) => hasDirectCharacterReferenceEvidence(name, searches))
  ) {
    return false;
  }
  if (
    names.some((name) => isEvidenceWorkTitleFragment(name, searches, input)) &&
    !names.some(
      (name) =>
        isRoleBoundLocalCharacterName(name, input) ||
        hasLocalCharacterGrammar(name, input) ||
        hasDirectCharacterReferenceEvidence(name, searches),
    )
  ) {
    return false;
  }
  if (
    names.every((name) => isCreatorNameOrFragment(name, input)) &&
    !names.some((name) =>
      hasExplicitCharacterRoleEvidence(name, searches, input),
    )
  ) {
    return false;
  }
  if (
    operation.criticalEvidenceTranslation === true &&
    names.some(
      (name) =>
        hasWorkBoundCharacterEvidence(name, searches, input) ||
        isRoleBoundLocalCharacterName(name, input) ||
        hasLocalCharacterGrammar(name, input),
    )
  ) {
    return true;
  }
  if (
    names.some(
      (name) =>
        isRoleBoundLocalCharacterName(name, input) ||
        hasLocalCharacterGrammar(name, input),
    )
  ) {
    return true;
  }
  return names.some((name) =>
    hasWorkBoundCharacterEvidence(name, searches, input),
  );
}

function isPublicationNameFragment(
  value: string,
  searches: readonly TavilySearchResponse[],
): boolean {
  if (!value || value.length > 40) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const publication = new RegExp(
    `(?:月刊|週刊|隔月刊)(?:少年|少女|青年)?${escaped}|${escaped}(?:編集部|コミックス|文庫|出版|書房)`,
    "u",
  );
  return searches.some((search) =>
    search.results.some((result) =>
      publication.test(primaryResearchEvidenceText(result)),
    ),
  );
}

function hasCompatibleKatakanaTargetInitial(
  source: string,
  operation: JsonRecord,
): boolean {
  if (!/^[ァ-ヺー]{2,20}$/u.test(source)) return true;
  const target =
    typeof operation.targetName === "string" ? operation.targetName.trim() : "";
  const sourceInitial = [...source][0] ?? "";
  const expected =
    BASIC_KATAKANA_TO_HANGUL[
      sourceInitial as keyof typeof BASIC_KATAKANA_TO_HANGUL
    ];
  const targetInitial = [...target][0] ?? "";
  if (!expected || !/^\p{Script=Hangul}$/u.test(targetInitial)) return true;
  return (
    hangulInitialConsonant(expected) === hangulInitialConsonant(targetInitial)
  );
}

function hangulInitialConsonant(value: string): number {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint >= 0xac00 && codePoint <= 0xd7a3
    ? Math.floor((codePoint - 0xac00) / 588)
    : -1;
}

function isEvidenceWorkTitleFragment(
  value: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  const key = normalizeLooseEvidenceKey(value);
  if (key.length < 4) return false;
  const knownTitleFragment = dedupeText([
    input.workTitle,
    ...cachedLikelyOriginalTitles(input),
    ...cachedTrustedEvidenceTitles(searches, input),
  ]).some((title) => {
    const titleKey = normalizeLooseEvidenceKey(title);
    return titleKey.length > key.length && titleKey.includes(key);
  });
  if (knownTitleFragment) return true;
  const titleHosts = new Set<string>();
  for (const search of searches) {
    for (const result of search.results) {
      const titleKey = normalizeLooseEvidenceKey(result.title);
      if (titleKey.length < key.length + 4 || !titleKey.includes(key)) continue;
      try {
        titleHosts.add(new URL(result.url).hostname.replace(/^www\./iu, ""));
      } catch (_error) {
        continue;
      }
    }
  }
  return titleHosts.size >= 2;
}

function looksLikeGenericCharacterLabel(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/\s+/gu, "");
  const role =
    "(?:主人公|ヒロイン|おっさん|おじさん|おばさん|男|女|男性|女性|日本人男性|日本人女性|少年|少女|青年|老人|老女|娘|息子|父|父親|母|母親|母上|父上|姉|妹|兄|弟|乳母|侍女|使用人|執事|メイド|王|王子|王女|皇子|皇女|令嬢|騎士|冒険者|魔術師|教師|学生|会社員|OL)";
  return (
    new RegExp(`^${role}$`, "iu").test(normalized) ||
    new RegExp(`^.{1,24}の${role}$`, "iu").test(normalized) ||
    /^(?:名前|本名|将来|未来|過去|前世|今世|正体|身元|人物|登場人物)$/u.test(
      normalized,
    ) ||
    /^(?:パーティ|パーティー|冒険者パーティ|冒険者パーティー|勇者一行|一行|ギルド|チーム|仲間(?:たち)?|相棒|同行者)$/u.test(
      normalized,
    )
  );
}

function isCreatorNameOrFragment(
  value: string,
  input: WorkContextResearchPromptInput,
): boolean {
  const valueKey = normalizeLooseEvidenceKey(value);
  if (valueKey.length < 3) return false;
  return cachedCreatorNames(input).some((creator) => {
    const creatorKey = normalizeLooseEvidenceKey(creator);
    return (
      creatorKey === valueKey ||
      creatorKey.startsWith(valueKey) ||
      creatorKey.endsWith(valueKey)
    );
  });
}

function hasDirectCharacterReferenceEvidence(
  name: string,
  searches: readonly TavilySearchResponse[],
): boolean {
  const key = normalizeLooseEvidenceKey(name);
  if (!key) return false;
  return searches.some((search) =>
    search.results.some(
      (result) =>
        hasCharacterReferencePath(result.url) &&
        normalizedPrimaryResearchEvidenceText(result).includes(key),
    ),
  );
}

function hasCharacterEvidence(
  name: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  if (looksLikeGenericKatakanaWebWord(name)) return false;
  const key = normalizeLooseEvidenceKey(name);
  if (key.length < 3) return false;
  return searches.some((search) =>
    search.results.some((result) => {
      const text = primaryResearchEvidenceText(result);
      if (!normalizeLooseEvidenceKey(text).includes(key)) return false;
      if (!isWorkBoundSearchResult(result, search.query, searches, input)) {
        return false;
      }
      return (
        isCharacterReferencePage(result, search.query) ||
        hasExplicitCharacterRoleInText(name, text)
      );
    }),
  );
}

function hasExplicitCharacterRoleEvidence(
  name: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  return searches.some((search) =>
    search.results.some(
      (result) =>
        isWorkBoundSearchResult(result, search.query, searches, input) &&
        hasExplicitCharacterRoleInText(
          name,
          `${result.title}\n${result.content}`,
        ),
    ),
  );
}

function hasExplicitCharacterRoleInText(name: string, text: string): boolean {
  const nameKey = normalizeLooseEvidenceKey(name);
  if (
    extractRoleBoundKatakanaNames(text).some(
      (candidate) => normalizeLooseEvidenceKey(candidate) === nameKey,
    )
  ) {
    return true;
  }
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?:登場人物|主人公|悪女|執事|幼馴染|少年|少女|青年|娘|息子|父|母|姉|妹|兄|弟|神|女神|英雄|王|王子|王女|皇帝|令嬢|聖女候補|聖女|婚約者|騎士|剣士|剣豪|剣神|冒険者|魔術師|魔法使い|メイド|教師|学生|友人|仲間|相棒|持ち主|ヒロイン|キャラ(?:クター)?|ギルドマスター|隊長|団長|部長|社長|博士)(?:の|[・･、，\\s:：]{0,8})[「『【（(]?${escapedName}[」』】）)]?(?=(?:は|が|を|に|の|と|から|へ|、|。|だった|である|\\s|$))|${escapedName}(?:さん|様|君|ちゃん|くん)|${escapedName}(?:という|と呼ばれる)(?:子供|少年|少女|青年|娘|息子|主人公|聖女候補|聖女|婚約者|冒険者|魔術師|騎士|剣士)|${escapedName}(?:も|が|は)(?:登場|現れ|加わる)`,
    "u",
  ).test(text);
}

function hasWorkBoundCharacterEvidence(
  name: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  const key = normalizeLooseEvidenceKey(name);
  if (key.length < 3 || looksLikeGenericKatakanaWebWord(name)) return false;
  const hosts = new Set<string>();
  let hasDirectOrOfficialSource = false;
  for (const search of searches) {
    for (const result of search.results) {
      const text = primaryResearchEvidenceText(result);
      const textKey = normalizeLooseEvidenceKey(text);
      if (!textKey.includes(key)) continue;
      if (!isWorkBoundSearchResult(result, search.query, searches, input)) {
        continue;
      }
      const explicitRole = hasExplicitCharacterRoleInText(name, text);
      const directCharacterPageName =
        isCharacterReferencePage(result, search.query) &&
        hasCharacterPageNameEvidence(name, text);
      if (!explicitRole && !directCharacterPageName) {
        continue;
      }
      try {
        const host = new URL(result.url).hostname.replace(/^www\./iu, "");
        if (isSocialEvidenceHost(host)) continue;
        hosts.add(host);
      } catch (_error) {
        continue;
      }
      hasDirectOrOfficialSource ||=
        directCharacterPageName ||
        hasDirectWorkPagePath(result.url) ||
        /(?:公式|official)/iu.test(result.title);
    }
  }
  return hasDirectOrOfficialSource || hosts.size >= 2;
}

function hasCharacterPageNameEvidence(name: string, text: string): boolean {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    /^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(name) ||
    new RegExp(
      `(?:^|\\n)\\s*(?:#{1,6}\\s*)?[「『【（(]?${escapedName}[」』】）)]?\\s*(?=\\n|$|[（(【]|\\[)`,
      "u",
    ).test(text)
  );
}

function hasCharacterIntentEvidence(
  name: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  if (looksLikeGenericKatakanaWebWord(name)) return false;
  const key = normalizeLooseEvidenceKey(name);
  if (key.length < 3) return false;
  return searches.some(
    (search) =>
      /(?:登場人物|キャラクター|character)/iu.test(search.query) &&
      search.results.some((result) => {
        if (
          !hasDirectWorkPagePath(result.url) ||
          !isWorkBoundSearchResult(result, search.query, searches, input)
        ) {
          return false;
        }
        const rawEvidence = primaryResearchEvidenceText(result);
        const evidence = normalizeLooseEvidenceKey(rawEvidence);
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        if (isCharacterReferencePage(result, search.query)) {
          return countNormalizedOccurrences(evidence, key) >= 1;
        }
        return new RegExp(
          `(?:登場人物|キャラクター)[^\\n]{0,80}\\n(?:[^\\n]{0,80}\\n){0,2}\\s*${escapedName}\\s*\\n\\s*[\\[【（(][^\\]】）)\\n]{0,100}(?:主人公|少年|少女|青年|娘|息子|父|母|姉|妹|兄|弟|神|女神|王|王子|王女|皇子|皇女|皇帝|令嬢|騎士|冒険者|魔術師|教師|学生|友人|仲間|ヒロイン|隊長|団長|博士)[^\\]】）)\\n]{0,100}[\\]】）)]`,
          "u",
        ).test(rawEvidence);
      }),
  );
}

function hasDirectWorkPagePath(value: string): boolean {
  try {
    return /\/(?:detail|product|products|book|books|comic|comics|manga|novel|series|title|work|works)(?:\/|$)/iu.test(
      new URL(value).pathname,
    );
  } catch (_error) {
    return false;
  }
}

function hasCharacterReferencePath(value: string): boolean {
  try {
    return /\/(?:chara|character|characters)(?:\/|$)/iu.test(
      new URL(value).pathname,
    );
  } catch (_error) {
    return false;
  }
}

function countNormalizedOccurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (needle && offset < value.length) {
    const index = value.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

function primaryResearchEvidenceText(
  result: TavilySearchResponse["results"][number],
): string {
  const cached = activeEvidenceCache?.primaryTexts.get(result);
  if (cached !== undefined) return cached;
  const marker =
    /(?:^|\n)\s*(?:#{1,6}\s*)?(?:関連小説|関連作品|おすすめ(?:作品|記事|レビュー)?|こちらもおすすめ|あなたへのおすすめ|もっと見る|作品一覧)(?=\s|$|[:：])/u.exec(
      result.content,
    );
  const content =
    marker?.index === undefined
      ? result.content
      : result.content.slice(0, marker.index);
  const text = `${result.title}\n${content}`;
  activeEvidenceCache?.primaryTexts.set(result, text);
  return text;
}

function normalizedPrimaryResearchEvidenceText(
  result: TavilySearchResponse["results"][number],
): string {
  const cached = activeEvidenceCache?.normalizedPrimaryTexts.get(result);
  if (cached !== undefined) return cached;
  const normalized = normalizeLooseEvidenceKey(
    primaryResearchEvidenceText(result),
  );
  activeEvidenceCache?.normalizedPrimaryTexts.set(result, normalized);
  return normalized;
}

function isWorkBoundSearchResult(
  result: TavilySearchResponse["results"][number],
  query: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): boolean {
  const activeCache = getActiveCache(input, searches);
  const byQuery = activeCache?.resultBindings.get(result);
  const cached = byQuery?.get(query);
  if (cached !== undefined) return cached;
  const bound = isResearchResultBoundToWork(
    result,
    input,
    query,
    needsJapaneseTitleRecovery(input.workTitle)
      ? cachedTrustedEvidenceTitles(searches, input)
      : [],
  );
  if (activeCache) {
    const bindings = byQuery ?? new Map<string, boolean>();
    bindings.set(query, bound);
    activeCache.resultBindings.set(result, bindings);
  }
  return bound;
}

function collectWorkBoundResults(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): WorkBoundResult[] {
  return searches.flatMap((search) =>
    search.results.flatMap((result) =>
      isWorkBoundSearchResult(result, search.query, searches, input)
        ? [{ query: search.query, result }]
        : [],
    ),
  );
}

function rawSourcesAreOnlySocial(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const hosts = value.flatMap((candidate) => {
    const source = readRecord(candidate);
    if (typeof source?.url !== "string") return [];
    try {
      return [new URL(source.url).hostname.replace(/^www\./iu, "")];
    } catch (_error) {
      return [];
    }
  });
  return hosts.length > 0 && hosts.every(isSocialEvidenceHost);
}

function buildMissingCriticalEvidenceOperations(
  operations: readonly unknown[],
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): JsonRecord[] {
  const missing = findMissingCriticalEvidenceCandidates(input, searches, {
    operations,
    warnings: [],
  });
  const localCandidates = cachedLocalCandidates(input);
  const roleBoundLocalNames = new Set(
    cachedRoleBoundLocalNames(input).map(normalizeLooseEvidenceKey),
  );
  return missing.flatMap((candidate) => {
    const reading = candidate.match(
      /^([\p{Script=Han}々〆ヶ]{1,30})[（(]([ァ-ヺー・]{2,40})[）)]$/u,
    );
    const source = reading?.[1] ?? candidate;
    const localTarget =
      findLocalTarget(source, localCandidates, input) ||
      (reading?.[2] ? findLocalTarget(reading[2], localCandidates, input) : "");
    const sources = findWorkBoundTextEvidenceSources(
      candidate,
      searches,
      input,
    );
    if (!localTarget || sources.length === 0) return [];
    if (
      /^[ァ-ヺー・]{3,30}$/u.test(candidate) ||
      roleBoundLocalNames.has(normalizeLooseEvidenceKey(candidate))
    ) {
      return [buildEvidenceCharacterOperation(candidate, localTarget, sources)];
    }
    if (
      !reading &&
      !/[一二三四五六七八九十百千0-9]+(?:大)?[\p{Script=Han}々〆ヶ]{2,12}$/u.test(
        candidate,
      )
    ) {
      return [];
    }
    return [
      buildEvidenceGlossaryOperation(
        source,
        localTarget,
        reading?.[2] ? [reading[2]] : [],
        sources,
      ),
    ];
  });
}

export type CriticalEvidenceTranslation = {
  source: string;
  target: string;
};

export function selectCriticalEvidenceTranslationCandidates(
  operations: readonly unknown[],
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): string[] {
  return withResearchEvidenceCache(input, searches, () =>
    selectCriticalEvidenceTranslationCandidatesCached(
      operations,
      searches,
      input,
    ),
  );
}

function selectCriticalEvidenceTranslationCandidatesCached(
  operations: readonly unknown[],
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): string[] {
  const represented = normalizeLooseEvidenceKey(JSON.stringify(input.guide));
  const localCandidates = cachedLocalCandidates(input);
  const roleBoundLocalNames = new Set(
    cachedRoleBoundLocalNames(input).map(normalizeLooseEvidenceKey),
  );
  const locallyAnchoredReadings: string[] = [];
  const explicitNamedWebTerms = dedupeText(
    cachedWorkBoundResults(searches, input).flatMap(({ result }) =>
      extractExplicitNamedTerms(`${result.title}\n${result.content}`),
    ),
  )
    .filter(
      (candidate) =>
        !looksLikeWebPageMetadata(candidate) &&
        !looksLikeGenericKatakanaWebWord(candidate) &&
        !looksLikeGenericDictionaryTerm(candidate) &&
        !isResearchWorkTitleSource(candidate, input, searches) &&
        !isCreatorNameOrFragment(candidate, input) &&
        hasExplicitTerminologyEvidence(candidate, searches, input) &&
        !criticalEvidenceCandidateIsRepresented(candidate, represented) &&
        !(
          /^[ァ-ヺー]{3,30}$/u.test(candidate) &&
          (hasCharacterEvidence(candidate, searches, input) ||
            hasCharacterIntentEvidence(candidate, searches, input))
        ),
    )
    .slice(0, 8);
  for (const { result } of cachedWorkBoundResults(searches, input)) {
    const text = `${result.title}\n${result.content}`;
    for (const match of text.matchAll(
      /([\p{Script=Han}々〆ヶ]{1,30})[（(]([ァ-ヺー・]{2,40})[）)]/gu,
    )) {
      const source = match[1] ?? "";
      const reading = match[2] ?? "";
      const candidate = match[0];
      if (
        looksLikeWebPageMetadata(source) ||
        (!localCandidateMatches(source, localCandidates) &&
          !localCandidateMatches(reading, localCandidates))
      ) {
        continue;
      }
      locallyAnchoredReadings.push(candidate);
    }
  }

  const officialCharacterNames = collectCharacterReferenceNames(
    searches,
    input,
  ).filter(
    (name) =>
      !isCreatorNameOrFragment(name, input) ||
      hasExplicitCharacterRoleEvidence(name, searches, input),
  );
  const locallyAnchoredOfficialNames = officialCharacterNames.filter((name) =>
    localCandidateMatches(name.split("・")[0] ?? name, localCandidates),
  );
  const explicitCharacterIntentNames = collectExplicitCharacterIntentNames(
    searches,
    input,
  );
  const untranslatedOperationCandidates = operations.flatMap((value) => {
    const operation = readRecord(value);
    if (
      !operation ||
      (!hasUntranslatedJapaneseTarget(operation) &&
        !hasIncompleteCharacterTarget(operation))
    ) {
      return [];
    }
    if (operation.entity === "glossary") {
      return typeof operation.source === "string" ? [operation.source] : [];
    }
    const names = Array.isArray(operation.sourceNames)
      ? operation.sourceNames.filter(
          (name): name is string => typeof name === "string",
        )
      : [];
    return names.flatMap((name) => {
      const roleBound = name.match(
        /^(?:主人公|悪女|執事|幼馴染|少年|少女|青年|娘|息子|父|母|姉|妹|兄|弟|神|女神|英雄|王|王子|王女|皇子|皇女|皇帝|令嬢|騎士|冒険者|魔術師|メイド|教師|学生|友人|仲間|ヒロイン|ギルドマスター|隊長|団長|部長|社長|博士)[・･]?([ァ-ヺー]{3,20})$/u,
      );
      return [roleBound?.[1] ?? name];
    });
  });
  const roleBoundEvidenceNames = findMissingCriticalEvidenceCandidates(
    input,
    searches,
    { operations: [], warnings: [] },
  ).filter(
    (candidate) =>
      /^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})*$/u.test(candidate) &&
      !looksLikeGenericKatakanaWebWord(candidate) &&
      (hasCharacterEvidence(candidate, searches, input) ||
        hasCharacterIntentEvidence(candidate, searches, input)),
  );
  const localEvidenceCandidates = localCandidates.flatMap((candidate) => {
    const source = candidate.source;
    if (
      looksLikeWebPageMetadata(source) ||
      looksLikeGenericKatakanaWebWord(source) ||
      findWorkBoundTextEvidenceSources(source, searches, input).length === 0
    ) {
      return [];
    }
    if (
      roleBoundLocalNames.has(normalizeLooseEvidenceKey(source)) ||
      (/^[ァ-ヺー]{3,30}$/u.test(source) &&
        hasCharacterEvidence(source, searches, input))
    ) {
      return [source];
    }
    if (
      /^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(source) ||
      isRoleBoundLocalCharacterName(source, input) ||
      (looksLikeMixedJapaneseCharacterName(source) &&
        hasLocalCharacterGrammar(source, input)) ||
      (/^[\p{Script=Han}々〆ヶ]{2,12}$/u.test(source) &&
        isLocallyQuotedTerm(source, input) &&
        !looksLikeGenericDictionaryTerm(source)) ||
      /^[ァ-ヺー]{2,16}[\p{Script=Han}々〆ヶ]{1,8}$/u.test(source) ||
      (/^[\p{Script=Han}々〆ヶ]{1,12}[ァ-ヺー・]{2,24}(?:[\p{Script=Han}々〆ヶ]{0,8})$/u.test(
        source,
      ) &&
        !looksLikeGenericDictionaryTerm(source)) ||
      /^[一二三四五六七八九十百千0-9]+(?:大)?[\p{Script=Han}々〆ヶ]{2,12}$/u.test(
        source,
      )
    ) {
      return [source];
    }
    return [];
  });

  const fullNamePrefixes = new Set(
    officialCharacterNames.map((name) =>
      normalizeLooseEvidenceKey(name.split("・")[0] ?? name),
    ),
  );
  return dedupeText([
    ...locallyAnchoredOfficialNames,
    ...officialCharacterNames,
    ...explicitCharacterIntentNames,
    ...roleBoundEvidenceNames,
    ...localEvidenceCandidates.filter(
      (candidate) =>
        !fullNamePrefixes.has(normalizeLooseEvidenceKey(candidate)),
    ),
    ...untranslatedOperationCandidates,
    ...locallyAnchoredReadings,
    ...explicitNamedWebTerms,
  ])
    .filter(
      (candidate) =>
        !looksLikeWebPageMetadata(candidate) &&
        !looksLikeGenericKatakanaWebWord(candidate) &&
        !isResearchWorkTitleSource(candidate, input, searches) &&
        (!isCreatorNameOrFragment(candidate, input) ||
          hasExplicitCharacterRoleEvidence(candidate, searches, input)) &&
        (!fullNamePrefixes.has(normalizeLooseEvidenceKey(candidate)) ||
          officialCharacterNames.some(
            (name) =>
              normalizeLooseEvidenceKey(name) ===
              normalizeLooseEvidenceKey(candidate),
          )) &&
        !criticalEvidenceCandidateIsRepresented(candidate, represented),
    )
    .slice(0, 12);
}

export function buildTranslatedCriticalEvidenceOperations(
  translations: readonly CriticalEvidenceTranslation[],
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
  allowedSourceCandidates?: readonly string[],
): JsonRecord[] {
  return withResearchEvidenceCache(input, searches, () =>
    buildTranslatedCriticalEvidenceOperationsCached(
      translations,
      searches,
      input,
      allowedSourceCandidates,
    ),
  );
}

function buildTranslatedCriticalEvidenceOperationsCached(
  translations: readonly CriticalEvidenceTranslation[],
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
  allowedSourceCandidates?: readonly string[],
): JsonRecord[] {
  const allowedCandidates = new Set(
    (
      allowedSourceCandidates ??
      selectCriticalEvidenceTranslationCandidatesCached([], searches, input)
    ).map(normalizeLooseEvidenceKey),
  );
  const seen = new Set<string>();
  return translations.flatMap(({ source, target }) => {
    const candidateKey = normalizeLooseEvidenceKey(source);
    const normalizedTarget = target.replace(/\s+/gu, " ").trim().slice(0, 160);
    if (
      !candidateKey ||
      isResearchWorkTitleSource(source, input, searches) ||
      !allowedCandidates.has(candidateKey) ||
      seen.has(candidateKey) ||
      !/\p{Script=Hangul}/u.test(normalizedTarget) ||
      /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(
        normalizedTarget,
      ) ||
      !translationTargetCoversFullName(source, normalizedTarget)
    ) {
      return [];
    }
    const sources = findWorkBoundTextEvidenceSources(source, searches, input);
    if (sources.length === 0) return [];
    seen.add(candidateKey);
    const reading = source.match(
      /^([\p{Script=Han}々〆ヶ]{1,30})[（(]([ァ-ヺー・]{2,40})[）)]$/u,
    );
    if (reading) {
      return [
        buildEvidenceGlossaryOperation(
          reading[1] ?? source,
          normalizedTarget,
          reading[2] ? [reading[2]] : [],
          sources,
        ),
      ];
    }
    if (
      /^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(source) ||
      isRoleBoundLocalCharacterName(source, input) ||
      (looksLikeMixedJapaneseCharacterName(source) &&
        hasLocalCharacterGrammar(source, input)) ||
      (/^[ァ-ヺー]{3,30}$/u.test(source) &&
        (hasCharacterEvidence(source, searches, input) ||
          hasCharacterIntentEvidence(source, searches, input)))
    ) {
      return [
        buildEvidenceCharacterOperation(source, normalizedTarget, sources),
      ];
    }
    return [
      buildEvidenceGlossaryOperation(source, normalizedTarget, [], sources),
    ];
  });
}

function looksLikeMixedJapaneseCharacterName(value: string): boolean {
  return /^[\p{Script=Han}々〆ヶ]{1,3}[ァ-ヺー]{2,16}$/u.test(value);
}

function isRoleBoundLocalCharacterName(
  value: string,
  input: WorkContextResearchPromptInput,
): boolean {
  const key = normalizeLooseEvidenceKey(value);
  return cachedRoleBoundLocalNames(input).some(
    (name) => normalizeLooseEvidenceKey(name) === key,
  );
}

function hasLocalCharacterGrammar(
  value: string,
  input: WorkContextResearchPromptInput,
): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}(?:には|とは|は|が)`, "u").test(
    input.selection.text,
  );
}

function isLocallyQuotedTerm(
  value: string,
  input: WorkContextResearchPromptInput,
): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`[「『【《]${escaped}[」』】》]`, "u").test(
    input.selection.text,
  );
}

function translationTargetCoversFullName(
  source: string,
  target: string,
): boolean {
  if (!/^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(source)) return true;
  const sourceParts = source.split("・").filter(Boolean);
  return target.split(/\s+/u).filter(Boolean).length >= sourceParts.length;
}

function collectCharacterReferenceNames(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): string[] {
  const names: string[] = [];
  for (const search of searches) {
    for (const result of search.results) {
      if (
        !isCharacterReferencePage(result, search.query) ||
        !isWorkBoundSearchResult(result, search.query, searches, input)
      ) {
        continue;
      }
      for (const match of `${result.title}\n${result.content}`.matchAll(
        /[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+/gu,
      )) {
        names.push(trimKatakanaNameSeparators(match[0]));
      }
    }
  }
  return dedupeText(names).filter(
    (name) =>
      !looksLikeWebPageMetadata(name) && !looksLikeGenericKatakanaWebWord(name),
  );
}

function collectExplicitCharacterIntentNames(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): string[] {
  const names: string[] = [];
  for (const search of searches) {
    if (!/(?:登場人物|キャラクター|character)/iu.test(search.query)) continue;
    for (const result of search.results) {
      if (
        !hasDirectWorkPagePath(result.url) ||
        !isWorkBoundSearchResult(result, search.query, searches, input)
      ) {
        continue;
      }
      const text = `${result.title}\n${result.content}`;
      names.push(...extractRoleBoundKatakanaNames(text));
      for (const match of text.matchAll(
        /(?:登場人物|キャラクター)[^\n]{0,80}\n(?:[^\n]{0,80}\n){0,2}\s*([ァ-ヺー]{3,20})\s*\n\s*[\u005b【（(][^\]】）)\n]{0,100}(?:主人公|少年|少女|青年|娘|息子|父|母|姉|妹|兄|弟|神|女神|王|王子|王女|皇子|皇女|皇帝|令嬢|騎士|冒険者|魔術師|教師|学生|友人|仲間|ヒロイン|隊長|団長|博士)[^\]】）)\n]{0,100}[\]】）)]/gu,
      )) {
        names.push(trimKatakanaNameSeparators(match[1] ?? ""));
      }
    }
  }
  return dedupeText(names).filter(
    (name) => !looksLikeGenericKatakanaWebWord(name),
  );
}

function localCandidateMatches(
  value: string,
  candidates: ReturnType<typeof extractLocalResearchCandidates>,
): boolean {
  const key = normalizeLooseEvidenceKey(value);
  if (key.length < 2) return false;
  return candidates.some((candidate) => {
    const localKey = normalizeLooseEvidenceKey(candidate.source);
    return localKey === key || (key.length >= 4 && localKey.includes(key));
  });
}

function criticalEvidenceCandidateIsRepresented(
  candidate: string,
  represented: string,
): boolean {
  const reading = candidate.match(
    /^([\p{Script=Han}々〆ヶ]{1,30})[（(]([ァ-ヺー・]{2,40})[）)]$/u,
  );
  if (reading) {
    return [reading[1], reading[2]].every((part) =>
      represented.includes(normalizeLooseEvidenceKey(part ?? "")),
    );
  }
  return represented.includes(normalizeLooseEvidenceKey(candidate));
}

function findLocalTarget(
  source: string,
  candidates: ReturnType<typeof extractLocalResearchCandidates>,
  input: WorkContextResearchPromptInput,
): string {
  const key = normalizeLooseEvidenceKey(source);
  const direct = candidates.find(
    (candidate) =>
      !candidate.targetIsContext &&
      normalizeLooseEvidenceKey(candidate.source) === key,
  );
  if (direct?.target) return direct.target;
  const targetTerms = [...input.workTitle.matchAll(/【([^】]{1,30})】/gu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  const localBracketTerms = [
    ...input.selection.text.matchAll(/[【《]([^】》]{1,30})[】》]/gu),
  ]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  if (
    targetTerms.length === 1 &&
    localBracketTerms.some(
      (candidate) => normalizeEvidenceKey(candidate) === key,
    )
  ) {
    return targetTerms[0] ?? "";
  }
  for (const originalTitle of cachedLikelyOriginalTitles(input)) {
    const sourceTerms = [...originalTitle.matchAll(/【([^】]{1,30})】/gu)]
      .map((match) => match[1] ?? "")
      .filter(Boolean);
    const index = sourceTerms.findIndex(
      (candidate) => normalizeEvidenceKey(candidate) === key,
    );
    if (index >= 0 && targetTerms[index]) return targetTerms[index] ?? "";
  }
  return "";
}

function buildEvidenceGlossaryOperation(
  source: string,
  target: string,
  aliases: string[],
  sources: Array<{ title: string; url: string }>,
): JsonRecord {
  return {
    entity: "glossary",
    action: "add",
    entryId: null,
    reason:
      "공식 인터넷 근거와 로컬 번역 문맥이 모두 확인된 핵심 세계관 용어를 보완합니다.",
    confidence: "high",
    sources,
    source,
    target,
    category: "term",
    aliases,
    note: null,
    displayName: null,
    sourceNames: null,
    targetName: null,
    speechStyle: null,
    customSpeechStyle: null,
  };
}

function buildEvidenceCharacterOperation(
  source: string,
  target: string,
  sources: Array<{ title: string; url: string }>,
): JsonRecord {
  return {
    entity: "character",
    action: "add",
    entryId: null,
    reason:
      "공식 인터넷 근거와 로컬 번역 문맥이 모두 확인된 인물 표기를 보완합니다.",
    confidence: "high",
    sources,
    source: null,
    target: null,
    category: null,
    aliases: [],
    note: null,
    displayName: target,
    sourceNames: [source],
    targetName: target,
    speechStyle: "neutral",
    customSpeechStyle: null,
    criticalEvidenceTranslation: true,
  };
}

function findTextEvidenceSources(
  value: string,
  searches: readonly TavilySearchResponse[],
): Array<{ title: string; url: string }> {
  const key = normalizeLooseEvidenceKey(value);
  if (!key) return [];
  const seen = new Set<string>();
  return searches
    .flatMap((search) => search.results)
    .flatMap((result) => {
      if (
        !result.url.startsWith("https://") ||
        isLowRelevanceListingUrl(result.url) ||
        seen.has(result.url) ||
        !normalizedPrimaryResearchEvidenceText(result).includes(key)
      ) {
        return [];
      }
      seen.add(result.url);
      return [{ title: result.title, url: result.url }];
    })
    .slice(0, 3);
}

function findWorkBoundTextEvidenceSources(
  value: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): Array<{ title: string; url: string }> {
  const key = normalizeLooseEvidenceKey(value);
  if (!key) return [];
  const seen = new Set<string>();
  return cachedWorkBoundResults(searches, input)
    .flatMap(({ result }) => {
      if (
        seen.has(result.url) ||
        !normalizedPrimaryResearchEvidenceText(result).includes(key)
      ) {
        return [];
      }
      seen.add(result.url);
      return [{ title: result.title, url: result.url }];
    })
    .slice(0, 3);
}

function collectEvidenceWorkTitles(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): EvidenceWorkTitle[] {
  const localTitles = cachedLikelyOriginalTitles(input);
  const corroboratedTitles = cachedTrustedEvidenceTitles(searches, input);
  const comparisonTitles = [
    ...localTitles,
    ...(/[぀-ヿ㐀-鿿]/u.test(input.workTitle) ? [input.workTitle] : []),
    ...corroboratedTitles,
  ];
  if (comparisonTitles.length === 0) return [];
  const byTitle = new Map<string, EvidenceWorkTitle>();
  for (const title of corroboratedTitles) {
    const sources = findTextEvidenceSources(title, searches);
    if (sources.length === 0) continue;
    byTitle.set(normalizeLooseEvidenceKey(title), {
      title,
      score: 1,
      sources,
    });
  }
  for (const result of searches.flatMap((search) => search.results)) {
    for (const rawCandidate of extractResultTitleCandidates(result.title)) {
      const candidate = stripKnownCreatorTitleSuffix(rawCandidate, input);
      const score = Math.max(
        ...comparisonTitles.map((title) =>
          titleIdentitySimilarity(candidate, title),
        ),
      );
      const key = normalizeLooseEvidenceKey(candidate);
      if (key.length < 8) continue;
      const source = { title: result.title, url: result.url };
      const current = byTitle.get(key);
      if (!current) {
        byTitle.set(key, { title: candidate, score, sources: [source] });
      } else if (!current.sources.some((item) => item.url === source.url)) {
        current.sources.push(source);
        current.score = Math.max(current.score, score);
      }
    }
  }
  const corroboratedKeys = new Set(
    corroboratedTitles.map((title) => normalizeLooseEvidenceKey(title)),
  );
  return [...byTitle.values()]
    .filter(
      (candidate) =>
        candidate.score >= 0.58 ||
        corroboratedKeys.has(normalizeLooseEvidenceKey(candidate.title)),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        scoreCanonicalTitle(right.title) - scoreCanonicalTitle(left.title) ||
        right.sources.length - left.sources.length ||
        left.title.length - right.title.length,
    );
}

export function extractCorroboratedEvidenceTitles(
  searches: readonly TavilySearchResponse[],
): string[] {
  const clusters: Array<{
    title: string;
    hosts: Set<string>;
    score: number;
  }> = [];
  for (const result of searches.flatMap((search) => search.results)) {
    const host = parseEvidenceHost(result.url);
    if (!host) continue;
    for (const title of [
      ...extractResultTitleCandidates(result.title),
      ...extractResultContentTitleCandidates(result.content),
    ]) {
      const key = normalizeLooseEvidenceKey(title);
      if (key.length < 8) continue;
      const current = clusters.find(
        (candidate) => titleIdentitySimilarity(candidate.title, title) >= 0.76,
      ) ?? { title, hosts: new Set<string>(), score: 0 };
      if (!clusters.includes(current)) clusters.push(current);
      current.hosts.add(host);
      current.score = Math.max(current.score, result.score);
      if (scoreCanonicalTitle(title) > scoreCanonicalTitle(current.title)) {
        current.title = title;
      }
    }
  }
  return clusters
    .filter((candidate) => candidate.hosts.size >= 2)
    .sort(
      (left, right) =>
        right.hosts.size - left.hosts.size ||
        right.score - left.score ||
        left.title.length - right.title.length,
    )
    .map((candidate) => candidate.title);
}

export function extractTrustedEvidenceTitles(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): string[] {
  return withResearchEvidenceCache(input, searches, () =>
    cachedTrustedEvidenceTitles(searches, input),
  );
}

function extractTrustedEvidenceTitlesCached(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): string[] {
  const candidates = dedupeText(
    [
      ...extractCorroboratedEvidenceTitles(searches),
      ...extractGuardedSingleSourceTitles(searches, input),
    ]
      .map(normalizeEvidenceTitleCandidate)
      .map((candidate) => stripKnownCreatorTitleSuffix(candidate, input))
      .filter(
        (candidate) =>
          candidate.length >= 8 &&
          candidate.length <= 160 &&
          isPlausibleEvidenceTitleCandidate(candidate),
      ),
  );
  const selected: string[] = [];
  for (const candidate of candidates) {
    const existingIndex = selected.findIndex(
      (current) => titleIdentitySimilarity(current, candidate) >= 0.76,
    );
    if (existingIndex < 0) {
      selected.push(candidate);
      continue;
    }
    const current = selected[existingIndex] ?? candidate;
    if (scoreCanonicalTitle(candidate) > scoreCanonicalTitle(current)) {
      selected[existingIndex] = candidate;
    }
  }
  return selected;
}

function extractGuardedSingleSourceTitles(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): string[] {
  const anchor = extractLatinTitleSearchAnchor(input.workTitle);
  if (!anchor) return [];
  const anchorKey = normalizeLooseEvidenceKey(anchor);
  const localCandidates = cachedLocalCandidates(input)
    .map((candidate) => candidate.source)
    .filter((candidate) => normalizeLooseEvidenceKey(candidate).length >= 3);
  if (localCandidates.length === 0) return [];
  const titles: string[] = [];
  for (const search of searches) {
    if (
      !normalizeLooseEvidenceKey(search.query).includes(anchorKey) ||
      !/(?:原題|日本語|公式)/u.test(search.query)
    ) {
      continue;
    }
    for (const result of search.results) {
      if (result.score < 0.6 || !hasDirectWorkPagePath(result.url)) continue;
      const evidence = normalizeLooseEvidenceKey(
        `${result.title}\n${result.content}`,
      );
      if (
        !localCandidates.some((candidate) =>
          evidence.includes(normalizeLooseEvidenceKey(candidate)),
        )
      ) {
        continue;
      }
      titles.push(
        ...extractResultTitleCandidates(result.title),
        ...extractResultContentTitleCandidates(result.content),
      );
    }
  }
  return titles;
}

function extractResultContentTitleCandidates(value: string): string[] {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const repeated = new Map<string, number>();
  for (const line of lines) {
    const key = normalizeLooseEvidenceKey(line);
    if (key.length >= 8) repeated.set(key, (repeated.get(key) ?? 0) + 1);
  }
  return dedupeText(
    lines.flatMap((rawLine) => {
      const wasHeading = /^#{1,6}\s+/u.test(rawLine);
      const line = normalizeEvidenceTitleCandidate(
        rawLine
          .replace(/^#{1,6}\s*/u, "")
          .replace(/\s+\/\s+.*$/u, "")
          .replace(/\s+(?:\[\.{3}\]|…+)\s*#.*$/u, "")
          .replace(/\s+[0-9０-９]+\s*(?:購入|巻|話|冊|試し読み|無料).*$/u, "")
          .replace(/\s+[0-9０-９]+\s*(?:[（(][^）)]{1,40}[）)])?\s*$/u, "")
          .trim(),
      );
      const key = normalizeLooseEvidenceKey(line);
      const hasTitleShape =
        wasHeading ||
        /[～〜~【】]/u.test(line) ||
        (repeated.get(normalizeLooseEvidenceKey(rawLine)) ?? 0) >= 2;
      if (
        !hasTitleShape ||
        line.length < 8 ||
        line.length > 160 ||
        !/[぀-ヿ㐀-鿿]/u.test(line) ||
        /^(?:Native|Japanese|Description|作品紹介|あらすじ)$/iu.test(line) ||
        !isPlausibleEvidenceTitleCandidate(line) ||
        key.length < 8
      ) {
        return [];
      }
      return [line];
    }),
  );
}

function scoreCanonicalTitle(value: string): number {
  let score = Math.min(value.length, 140);
  if (/[～〜~]/u.test(value)) score += 25;
  if (/[0-9０-９]+\s*[～〜~]/u.test(value)) score -= 35;
  if (/[|｜]|\s\/\s/u.test(value)) score -= 100;
  score -= (value.match(/\s[-–—]\s/gu)?.length ?? 0) * 180;
  if (/(?:購入|試し読み|無料|\[\.{3}\]|#)/u.test(value)) score -= 500;
  if (!isPlausibleEvidenceTitleCandidate(value)) score -= 1_000;
  if (/(?:公式|出版社)$/u.test(value)) {
    score -= 20;
  }
  return score;
}

export function extractResultTitleCandidates(value: string): string[] {
  const titleText = value.replace(/<br\s*\/?>/giu, " | ");
  const quotedTitles = [
    ...titleText.matchAll(/[『「《]([^』」》]{8,158})[』」》]/gu),
  ]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
  const candidates = [
    ...quotedTitles,
    titleText,
    ...titleText.split(/\s+(?:[-–—|｜/])\s+|[|｜]/u),
  ];
  return dedupeText(
    candidates
      .map((candidate) =>
        normalizeEvidenceTitleCandidate(
          candidate
            .replace(
              /^【(?:web|ウェブ|書籍|電子|コミック|漫画|小説|単行本|文庫)版】\s*/iu,
              "",
            )
            .replace(
              /^(?:【|\[)?(?:第)?[0-9０-９一二三四五六七八九十]+話(?:】|\])?\s*/u,
              "",
            )
            .replace(
              /\s+(?:第?[0-9０-９一二三四五六七八九十]+巻|[0-9０-９]+(?:話|冊)).*$/u,
              "",
            )
            .replace(
              /([ぁ-んァ-ヺ一-龯）】])(?:[0-9０-９]+|[①-⑳])(?=\s*[～〜~])/u,
              "$1",
            )
            .replace(/\s+/gu, " ")
            .trim(),
        ),
      )
      .filter(
        (candidate) =>
          candidate.length >= 8 &&
          candidate.length <= 160 &&
          !/(?:…|\.\.{2,}|･{2,})/u.test(candidate) &&
          isPlausibleEvidenceTitleCandidate(candidate) &&
          /[぀-ヿ㐀-鿿]/u.test(candidate),
      ),
  );
}

function normalizeEvidenceTitleCandidate(value: string): string {
  let normalized = value
    .replace(/<br\s*\/?>/giu, " | ")
    .replace(/<[^>]{1,80}>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:\*{1,3}|_{1,3}|#{1,6})\s*/u, "")
    .replace(/\s*(?:\*{1,3}|_{1,3})$/u, "")
    .replace(/\s*[|｜].*$/u, "")
    .replace(/^[0-9０-９]+\s*[.)．]\s*/u, "")
    .replace(/^[「『\u005b]+/u, "")
    .replace(
      /^【[^】]{1,60}(?:発売|配信|更新|書籍|コミック|漫画|特典|無料)[^】]*】\s*/u,
      "",
    )
    .replace(
      /^(?:(?:Native|Japanese(?: title)?|Original(?: title)?)|原題|作品名|タイトル)\s*[:：]\s*/iu,
      "",
    )
    .replace(/^(?:【|\[)?(?:最新刊|新刊|新着|話題作)(?:】|\])?\s*/u, "")
    .replace(
      /(?:の)?(?:考察|ネタバレ|感想)(?:[・･／/、,](?:考察|ネタバレ|感想))*.*$/u,
      "",
    )
    .replace(/\s*[【《「『][^】》」』\n]{0,80}(?:…|\.{2,})[^】》」』\n]*$/u, "")
    .replace(
      /\s*[【《「『\u005b](?=[^】》」』\]\n]{0,80}(?:分冊|合本|電子|書籍|限定|特典|特別|カラー|試し読み|無料|版))[^】》」』\]\n]*$/u,
      "",
    )
    .replace(
      /\s*[（(](?:全\s*)?[0-9０-９一二三四五六七八九十]+\s*巻[）)]\s*(?:(?:[\p{Script=Latin}][\p{Script=Latin}\p{N}._☆★-]{1,30}|電子書籍|電子|コミック|単行本)\s*)?版?\s*$/iu,
      "",
    )
    .replace(
      /\s+(?:(?:[\p{Script=Latin}][\p{Script=Latin}\p{N}._☆★-]{1,30}|電子書籍|電子|コミック|単行本)\s*)版\s*$/iu,
      "",
    )
    .replace(
      /\s*[（(][^）)]{0,40}(?:[A-Z]{1,6}|コミックス|文庫|レーベル|書籍|単行本|電子版|ラノベ|ノベルス|ブックス)[^）)]{0,20}[）)]\s*$/iu,
      "",
    )
    .replace(
      /(?:\s*[,，]\s*[0-9０-９]+\s*\.?\s*[\p{Script=Latin}]{2,12}|\s+[\p{Script=Latin}]{2,12}\.?\s*[0-9０-９]+)\s*$/iu,
      "",
    )
    .replace(
      /\s*[（(]\s*[0-9０-９一二三四五六七八九十]+\s*[）)]\s*[,，]?\s*$/u,
      "",
    )
    .replace(/^[\s:：・･\-–—【《「『\u005b]+/u, "")
    .replace(
      /\s*【(?=[^】]{0,80}(?:電子(?:書籍)?|限定|特典|特別版|カラー))[^】]{1,80}】\s*(?:のレビュー)?\s*$/u,
      "",
    )
    .replace(/[】》」』\]]+$/u, "");
  const breadcrumbParts = normalized
    .split(/\s*[>＞›»]\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const breadcrumbTail = breadcrumbParts.at(-1) ?? "";
  if (
    breadcrumbTail.length >= 8 &&
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(
      breadcrumbTail,
    ) &&
    (breadcrumbParts.length >= 3 ||
      /^(?:top|home|トップ|ホーム)$/iu.test(breadcrumbParts[0] ?? ""))
  ) {
    normalized = breadcrumbTail;
  }
  normalized = stripLeadingWebActionLabel(normalized);
  normalized = stripLeadingResultPositionDecoration(normalized);
  normalized = stripLeadingAwardDecoration(normalized);
  normalized = stripLeadingPublicationStatus(normalized);
  normalized = stripRepeatedSerializationDecoration(normalized);
  normalized = stripLeadingNavigationDecoration(normalized);
  normalized = normalized
    .replace(/\s*(?:[（(]\s*[）)]|【\s*】|「\s*」|『\s*』|《\s*》)\s*$/u, "")
    .trim();
  normalized = normalized.replace(
    /\s*[-–—]\s*(?:WEB|ウェブ)\s*(?:読み|版|連載|コミック|小説)?\s*$/iu,
    "",
  );
  const creatorAttributedTitle = normalized.match(
    /^[\p{L}\p{N}々〆ヶ._-]{2,40}[「『《]([^」』》\n]{8,158})(?:[」』》]|$)/u,
  );
  if (creatorAttributedTitle?.[1]) {
    normalized = creatorAttributedTitle[1].trim();
  }
  const publicationLabelPrefix = normalized.match(
    /^[\p{L}\p{N}々〆ヶ._-]{1,40}(?:コミックス|文庫|出版|書房|ブックス|レーベル)\s+(.{8,158})$/u,
  );
  if (publicationLabelPrefix?.[1]) {
    normalized = publicationLabelPrefix[1].trim();
  }
  const publisherSuffix =
    /\s*[（(][^）)]{0,40}(?:書房|出版社|出版|コミックス|文庫|レーベル)[^）)]{0,20}[）)](?:\s+[\p{L}\p{N}々〆ヶ._·・,，／/\-\s]{1,100})?$/u;
  if (publisherSuffix.test(normalized)) {
    normalized = normalized
      .replace(publisherSuffix, "")
      .replace(
        /\s*【(?=[^】]{0,80}(?:電子(?:書籍)?|限定|特典|特別版|カラー))[^】]{1,80}】\s*(?:のレビュー)?\s*$/u,
        "",
      )
      .replace(/\s*(?:第\s*)?[1-9１-９一二三四五六七八九十]+(?:巻)?$/u, "")
      .trim();
  }
  normalized = normalized.replace(
    /\s*[（(][\p{Script=Han}々〆ヶァ-ヺーA-Za-z]{1,16}(?:\s+[\p{Script=Han}々〆ヶァ-ヺーA-Za-z]{1,16}){1,3}[）)]$/u,
    "",
  );
  normalized = normalized.replace(
    /\s*[（(]\s*(?:第\s*)?[0-9０-９一二三四五六七八九十]+\s*(?:巻)?\s*[）)]\s*(?=[～〜~])/u,
    "",
  );
  normalized = normalized.replace(
    /^(.{8,60}?)[1-9１-９][0-9０-９]?(?=\s+(?:[0-9０-９]{1,3}(?:禁|歳)|[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]))/u,
    "$1",
  );
  normalized = normalized.replace(
    /^(.{8,158}?)(?:\s*第?\s*)[1-9１-９][0-9０-９]?(?:巻)?$/u,
    "$1",
  );
  normalized = normalized.replaceAll("〜", "～");
  const duplicatedTitle = normalized.match(/^(.{8,100})\s+\1$/u);
  if (duplicatedTitle?.[1]) {
    normalized = duplicatedTitle[1].trim();
  }
  const firstJapaneseIndex = normalized.search(
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  );
  if (firstJapaneseIndex > 0) {
    const prefix = normalized.slice(0, firstJapaneseIndex);
    if (
      prefix.length <= 80 &&
      !looksLikeEmbeddedWebUiAnnotation(prefix) &&
      /(?:volume|vol\.?|book|edition|native|japanese|original|title)\b/iu.test(
        prefix,
      )
    ) {
      normalized = normalized.slice(firstJapaneseIndex).trim();
    }
  }
  const providerSeparatorIndex = normalized.indexOf("の");
  if (providerSeparatorIndex > 0 && providerSeparatorIndex <= 32) {
    const provider = normalized.slice(0, providerSeparatorIndex);
    const remainder = normalized.slice(providerSeparatorIndex + 1).trim();
    if (
      looksLikeGenericKatakanaWebWord(provider) &&
      remainder.length >= 8 &&
      /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(remainder)
    ) {
      normalized = remainder;
    }
  }
  const waveIndexes = [...normalized.matchAll(/[～〜~]/gu)].map(
    (match) => match.index,
  );
  if (waveIndexes.length >= 2) {
    const closingWave = waveIndexes.at(-1);
    if (closingWave !== undefined) {
      normalized = normalized.slice(0, closingWave + 1).trim();
    }
  }
  if (normalized.length >= 20 && /[～〜~]/u.test(normalized)) {
    normalized = normalized.replace(
      /([～〜~])\s*[（(][ァ-ヺー・\p{Script=Han}々〆ヶA-Za-z\s]{2,40}[）)]$/u,
      "$1",
    );
  }
  const wrapped = normalized.match(
    /^[【《「『\u005b]([^】》」』\]]{8,158})[】》」』\]]$/u,
  );
  if (wrapped?.[1]) normalized = wrapped[1].trim();
  return normalized;
}

function stripKnownCreatorTitleSuffix(
  value: string,
  input: WorkContextResearchPromptInput,
): string {
  let normalized = value.trim();
  for (const creator of cachedCreatorNames(input)) {
    if (!creator || creator.length > 80) continue;
    const escaped = creator.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    normalized = normalized.replace(
      new RegExp(`\\s*[（(]\\s*${escaped}\\s*[）)]\\s*$`, "u"),
      "",
    );
  }
  return normalized.trim();
}

function stripCorroboratedParentheticalTitleSuffix(
  value: string,
  searches: readonly TavilySearchResponse[],
): string {
  const match = value
    .trim()
    .match(/^(.{8,150}?)\s*[（(]([^）)\n]{2,40})[）)]\s*$/u);
  const base = match?.[1]?.trim() ?? "";
  if (!base || !/[぀-ヿ㐀-鿿]/u.test(base)) return value;
  const baseKey = normalizeLooseEvidenceKey(base);
  const hasIndependentBaseTitle = searches.some((search) =>
    search.results.some((result) =>
      [
        ...extractResultTitleCandidates(result.title),
        ...extractResultContentTitleCandidates(result.content),
      ].some((candidate) => normalizeLooseEvidenceKey(candidate) === baseKey),
    ),
  );
  return hasIndependentBaseTitle ? base : value;
}

function stripTranslatedPublicationSuffixWhenSourceWasCanonicalized(
  value: string,
  sourceWasCanonicalized: boolean,
): string {
  return sourceWasCanonicalized
    ? value.replace(/\s*[（(][^）)\n]{1,60}[）)]\s*$/u, "").trim()
    : value;
}

function isPlausibleEvidenceTitleCandidate(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return false;
  if (
    /\.\.{2,}|･{2,}/u.test(normalized) ||
    looksLikeEmbeddedWebUiAnnotation(normalized) ||
    stripRepeatedSerializationDecoration(normalized) !== normalized ||
    stripLeadingNavigationDecoration(normalized) !== normalized ||
    /(?:[（(]\s*[）)]|【\s*】|「\s*」|『\s*』|《\s*》)/u.test(normalized) ||
    (/^[^～〜~]*[～〜~]$/u.test(normalized) &&
      (normalized.match(/[～〜~]/gu)?.length ?? 0) === 1)
  ) {
    return false;
  }
  if (
    /^\+|^(?:イラスト|原作|作画|漫画|著者|作者|原案|構成)\s*[:：]/u.test(
      normalized,
    )
  ) {
    return false;
  }
  if (/。$/u.test(normalized)) return false;
  if (/(?:[×xX].*[=＝]|[=＝].*[×xX]).*[!?！？]{1,3}$/u.test(normalized)) {
    return false;
  }
  for (const [opening, closing] of [
    ["【", "】"],
    ["「", "」"],
    ["『", "』"],
    ["《", "》"],
  ] as const) {
    if (
      countTextToken(normalized, closing) !==
      countTextToken(normalized, opening)
    ) {
      return false;
    }
  }
  const sentenceMarks = normalized.match(/[。！？!?]/gu)?.length ?? 0;
  if (sentenceMarks >= 3) return false;
  if (
    /(?:あらすじ|作品紹介|最新刊|試し読み|無料漫画|発売された|配信開始|ファンタジー[、,]開幕)/u.test(
      normalized,
    )
  ) {
    return false;
  }
  return true;
}

function looksLikeEmbeddedWebUiAnnotation(value: string): boolean {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return (
    /\b[A-Za-z][A-Za-z -]{2,80}\.\s*(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])/u.test(
      normalized,
    ) ||
    /\b(?:alt(?:ernative)?\s+text|(?:cover|preview|thumbnail|script)\s+(?:image|icon)|(?:image|icon|thumbnail|logo|badge|button)\s+(?:placeholder|preview|label))\b/iu.test(
      normalized,
    )
  );
}

function stripLeadingWebActionLabel(value: string): string {
  const match = value.match(
    /^(?:(?:add\s+to|read|shelve|bookmark|follow|save|preview|view|open|share|favou?rite|track|subscribe|library|details?))\s+([\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}].{7,158})$/iu,
  );
  return match?.[1]?.trim() ?? value;
}

function stripLeadingResultPositionDecoration(value: string): string {
  return value
    .replace(
      /^\s*[（(]?\s*[0-9０-９]+\s*(?:ページ目|頁目|pages?)\s*[）)]?\s*(?:公式|official)?\s*[-–—:：]?\s*/iu,
      "",
    )
    .trim();
}

function stripLeadingAwardDecoration(value: string): string {
  const match = value.match(
    /^(?:(?:第\s*)?[0-9０-９一二三四五六七八九十]+回)?[^\s\u3000]{1,48}(?:大賞|グランプリ|アワード|コンテスト)[0-9０-９]{0,4}(?:\s*(?:受賞|ノミネート)(?:作|作品)?)?\s+(.{8,158})$/u,
  );
  return match?.[1]?.trim() ?? value;
}

function stripLeadingPublicationStatus(value: string): string {
  return value
    .replace(
      /^(?:コミック|漫画|マンガ|小説|書籍|単行本|電子書籍)\s*(?:好評)?(?:発売中|配信中|連載中|公開中)\s*[-–—:：]?\s*/u,
      "",
    )
    .trim();
}

function stripLeadingNavigationDecoration(value: string): string {
  const match = value.match(
    /^([^\p{L}\p{N}]{1,8})([\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}].{7,158})$/u,
  );
  if (!match?.[2] || /[【「『《（(\u005b]/u.test(match[1] ?? "")) return value;
  return match[2].trim();
}

function stripRepeatedSerializationDecoration(value: string): string {
  const stripProviderLabel = (candidate: string) =>
    candidate
      .replace(
        /^(?:[A-Z]{2,8})\s+(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])/u,
        "",
      )
      .trim();
  const stripTrailingDecoration = (candidate: string) =>
    stripProviderLabel(
      candidate
        .replace(
          /\s*[【\u005b][^】\]]{0,40}(?:連載|分冊|合本|電子|単行本|版)[^】\]]{0,20}[】\]].*$/u,
          "",
        )
        .trim(),
    );
  const providerSegments = value
    .split(/\s*\([A-Za-z0-9]{1,12}\)\s*/u)
    .filter(Boolean);
  if (providerSegments.length === 2) {
    const left = stripTrailingDecoration(providerSegments[0] ?? "");
    const right = stripTrailingDecoration(providerSegments[1] ?? "");
    if (
      left.length >= 8 &&
      normalizeLooseEvidenceKey(left) === normalizeLooseEvidenceKey(right)
    ) {
      return left;
    }
  }
  return stripTrailingDecoration(value);
}

function countTextToken(value: string, token: string): number {
  return value.split(token).length - 1;
}

function findCanonicalEvidenceTitle(
  source: string,
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): EvidenceWorkTitle | null {
  if (
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(
      input.workTitle,
    )
  ) {
    const localTitleKey = normalizeLooseEvidenceKey(input.workTitle);
    const sourceKey = normalizeLooseEvidenceKey(source);
    const localSources = findTextEvidenceSources(input.workTitle, searches);
    if (
      localSources.length > 0 &&
      (sourceKey.includes(localTitleKey) || localTitleKey.includes(sourceKey))
    ) {
      return { title: input.workTitle, score: 1, sources: localSources };
    }
  }
  return (
    cachedEvidenceWorkTitles(searches, input).find(
      (candidate) => titleIdentitySimilarity(candidate.title, source) >= 0.58,
    ) ?? null
  );
}

function enrichGlossaryOperation(
  operation: JsonRecord,
  readings: ReadonlyMap<string, string[]>,
  input: WorkContextResearchPromptInput,
  searches: readonly TavilySearchResponse[],
): JsonRecord {
  const source = typeof operation.source === "string" ? operation.source : "";
  const sourceReading = source.match(
    /^([\p{Script=Han}々〆ヶ]{1,30})[（(]([ァ-ヺー・]{2,40})[）)]$/u,
  );
  const sourceBase = sourceReading?.[1] ?? source;
  const embeddedTitle = extractEmbeddedEvidenceTitle(source, searches);
  const sourceWithoutPublicationSuffix =
    stripCorroboratedParentheticalTitleSuffix(source, searches);
  const normalizedTitleSource =
    embeddedTitle ||
    (sourceWithoutPublicationSuffix !== source
      ? sourceWithoutPublicationSuffix
      : "") ||
    extractResultTitleCandidates(source).find((candidate) =>
      isResearchWorkTitleSource(candidate, input, searches),
    ) ||
    source;
  const titleOperation =
    Boolean(embeddedTitle) ||
    isResearchWorkTitleSource(normalizedTitleSource, input, searches);
  const canonicalTitle = titleOperation
    ? embeddedTitle
      ? {
          title: embeddedTitle,
          score: 1,
          sources: findTextEvidenceSources(embeddedTitle, searches),
        }
      : sourceWithoutPublicationSuffix !== source
        ? {
            title: sourceWithoutPublicationSuffix,
            score: 1,
            sources: findTextEvidenceSources(
              sourceWithoutPublicationSuffix,
              searches,
            ),
          }
        : findCanonicalEvidenceTitle(normalizedTitleSource, searches, input)
    : null;
  const preferredNormalizedTitle =
    titleOperation &&
    normalizedTitleSource !== source &&
    isPlausibleEvidenceTitleCandidate(normalizedTitleSource)
      ? normalizedTitleSource
      : "";
  const sourceKey = normalizeEvidenceKey(sourceBase);
  const evidenceAliases = readings.get(sourceKey) ?? [];
  const aliases = readSourceAliases(operation.aliases);
  const evidenceSources = canonicalTitle?.sources.length
    ? canonicalTitle.sources
    : findTextEvidenceSources(source, searches);
  const criticalTarget =
    evidenceSources.length > 0 &&
    (evidenceAliases.length > 0 ||
      /[一二三四五六七八九十百千0-9]+(?:大)?[\p{Script=Han}々〆ヶ]{2,12}$/u.test(
        source,
      ))
      ? findLocalTarget(sourceBase, cachedLocalCandidates(input), input)
      : "";
  const originalTarget =
    typeof operation.target === "string" ? operation.target : "";
  const translatedTitleTarget = titleOperation
    ? stripTranslatedPublicationSuffixWhenSourceWasCanonicalized(
        sanitizeTranslatedWorkTitleTarget(originalTarget),
        sourceWithoutPublicationSuffix !== source,
      )
    : originalTarget;
  const hasReadingAlias = [...evidenceAliases, ...aliases].some((alias) =>
    /^[ァ-ヺー・]{2,40}$/u.test(alias),
  );
  const readingTarget =
    sourceReading || hasReadingAlias
      ? originalTarget.replace(/\s*[（(][^）)]{1,80}[）)]\s*$/u, "").trim()
      : originalTarget;
  return {
    ...operation,
    ...(preferredNormalizedTitle
      ? { source: preferredNormalizedTitle }
      : canonicalTitle
        ? { source: canonicalTitle.title }
        : titleOperation && normalizedTitleSource !== source
          ? { source: normalizedTitleSource }
          : sourceReading
            ? { source: sourceBase }
            : {}),
    ...(titleOperation
      ? {
          target: /\p{Script=Hangul}/u.test(input.workTitle)
            ? input.workTitle
            : translatedTitleTarget,
          category: "other",
          criticalTitleTranslation: true,
        }
      : criticalTarget
        ? { target: criticalTarget }
        : readingTarget && readingTarget !== originalTarget
          ? { target: readingTarget }
          : {}),
    aliases: dedupeText([
      ...(canonicalTitle && canonicalTitle.title !== source ? [source] : []),
      ...(titleOperation
        ? cachedLikelyOriginalTitles(input).filter(
            (title) =>
              normalizeLooseEvidenceKey(title) !==
              normalizeLooseEvidenceKey(canonicalTitle?.title ?? source),
          )
        : []),
      ...evidenceAliases,
      ...(sourceReading?.[2] ? [sourceReading[2]] : []),
      ...aliases,
    ]),
    sources: mergeRawSources(operation.sources, evidenceSources),
  };
}

function extractEmbeddedEvidenceTitle(
  source: string,
  searches: readonly TavilySearchResponse[],
): string {
  const quoted = [...source.matchAll(/[『「《]([^』」》]{8,158})[』」》]/gu)]
    .map((match) => normalizeEvidenceTitleCandidate(match[1] ?? ""))
    .filter(
      (candidate) =>
        candidate.length >= 8 &&
        candidate.length <= 160 &&
        /[぀-ヿ㐀-鿿]/u.test(candidate) &&
        isPlausibleEvidenceTitleCandidate(candidate),
    )
    .sort(
      (left, right) => scoreCanonicalTitle(right) - scoreCanonicalTitle(left),
    );
  return (
    quoted.find(
      (candidate) => findTextEvidenceSources(candidate, searches).length > 0,
    ) ?? ""
  );
}

function sanitizeTranslatedWorkTitleTarget(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!/\p{Script=Hangul}/u.test(normalized)) return normalized;
  const wrappedTitle = normalized.match(
    /^(?:(?:TV|웹)\s*)?(?:애니메이션|애니|만화|코믹|웹툰|소설)\s*[『「【《]([^』」】》]{4,140})[』」】》]\s*(?:(?:공식|프로모션|티저|PV|사이트|홈페이지|제?[0-9]+탄|영상|채널|계정)[\s@()_A-Za-z0-9.-]*)*$/u,
  );
  if (wrappedTitle?.[1] && /\p{Script=Hangul}/u.test(wrappedTitle[1])) {
    return wrappedTitle[1].trim();
  }
  const parts = normalized.split(/\s+(?:\/|／|[|｜])\s+/u);
  if (
    parts.length > 1 &&
    /(?:원작|작화|만화|저자|작가|글|그림|캐릭터|추천|무료|공식|사이트|출판|코믹|니코니코)/u.test(
      parts.slice(1).join(" "),
    )
  ) {
    return parts[0]?.trim() || normalized;
  }
  return normalized;
}

function isEvidenceBackedWorkTitleSource(
  source: string,
  searches: readonly TavilySearchResponse[],
): boolean {
  const sourceKey = normalizeLooseEvidenceKey(source);
  if (sourceKey.length < 8) return false;
  return searches
    .flatMap((search) => search.results)
    .some(
      (result) =>
        normalizeLooseEvidenceKey(result.title).includes(sourceKey) ||
        titleIdentitySimilarity(result.title, source) >= 0.68,
    );
}

function isOriginalTitleSource(
  source: string,
  originalTitles: readonly string[],
): boolean {
  const sourceKey = normalizeLooseEvidenceKey(source);
  if (!sourceKey) return false;
  return originalTitles.some((title) => {
    const titleKey = normalizeLooseEvidenceKey(title);
    return (
      sourceKey === titleKey ||
      editDistanceAtMostOne(sourceKey, titleKey) ||
      titleIdentitySimilarity(source, title) >= 0.68
    );
  });
}

function isResearchWorkTitleSource(
  source: string,
  input: WorkContextResearchPromptInput,
  searches: readonly TavilySearchResponse[],
): boolean {
  if (!isPlausibleEvidenceTitleCandidate(source)) return false;
  const localTitles = [
    ...(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(
      input.workTitle,
    )
      ? [input.workTitle]
      : []),
    ...cachedLikelyOriginalTitles(input),
  ];
  if (isOriginalTitleSource(source, localTitles)) return true;
  if (isQuotedPublicationTitleSource(source, searches)) return true;
  if (normalizeLooseEvidenceKey(source).length < 6) return false;
  return (
    isOriginalTitleSource(
      source,
      cachedTrustedEvidenceTitles(searches, input),
    ) || isEvidenceBackedWorkTitleSource(source, searches)
  );
}

function isQuotedPublicationTitleSource(
  source: string,
  searches: readonly TavilySearchResponse[],
): boolean {
  if (source.length < 8 || source.length > 160) return false;
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const quoted = new RegExp(`[『「《]${escaped}[』」》]`, "u");
  return searches.some((search) =>
    search.results.some((result) => {
      const text = `${result.title}\n${result.content}`;
      return (
        quoted.test(text) &&
        (hasDirectWorkPagePath(result.url) ||
          /(?:第?[一二三四五六七八九十0-9]+巻|発売|配信|連載|作品|書籍|コミック|原作|著者|作者)/u.test(
            text,
          ))
      );
    }),
  );
}

function readSourceAliases(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (alias): alias is string =>
          typeof alias === "string" && !/\p{Script=Hangul}/u.test(alias),
      )
    : [];
}

function operationIdentity(operation: JsonRecord): string {
  const entity = String(operation.entity ?? "unknown");
  const entryId =
    typeof operation.entryId === "string" ? operation.entryId : "";
  if (entryId) return `${entity}:id:${entryId}`;
  const source =
    entity === "character" && Array.isArray(operation.sourceNames)
      ? operation.sourceNames.find((value) => typeof value === "string")
      : operation.source;
  const sourceIdentity = normalizeEvidenceKey(String(source ?? ""));
  return `${entity}:name:${sourceIdentity}`;
}

function collectOfficialKatakanaNames(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): OfficialNameEvidence[] {
  const byName = new Map<string, OfficialNameEvidence>();
  for (const search of searches) {
    for (const result of search.results) {
      if (!isWorkBoundSearchResult(result, search.query, searches, input)) {
        continue;
      }
      const text = `${result.title}\n${result.content}`;
      const authoritySignal =
        /(?:公式|official|出版社|出版|刊行|著者|原作|作品紹介)/iu.test(
          `${result.title}\n${result.content.slice(0, 800)}`,
        ) || isCharacterReferencePage(result, search.query);
      const names = [
        ...extractRoleBoundKatakanaNames(text),
        ...(isCharacterReferencePage(result, search.query)
          ? [...text.matchAll(/[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+/gu)].map(
              (match) => match[0],
            )
          : []),
      ];
      for (const rawName of names) {
        const name = trimKatakanaNameSeparators(rawName);
        if (!name) continue;
        const current = byName.get(name) ?? {
          name,
          sources: [],
          authoritySignal: false,
        };
        if (!current.sources.some((source) => source.url === result.url)) {
          current.sources.push({ title: result.title, url: result.url });
        }
        current.authoritySignal ||= authoritySignal;
        byName.set(name, current);
      }
    }
  }
  return [...byName.values()].filter(
    (candidate) => candidate.authoritySignal || candidate.sources.length >= 2,
  );
}

function isCharacterReferencePage(
  result: TavilySearchResponse["results"][number],
  query: string,
): boolean {
  return (
    hasCharacterReferencePath(result.url) &&
    /(?:登場人物|キャラクター|character)/iu.test(`${query}\n${result.title}`)
  );
}

function enrichCharacterSpelling(
  operation: JsonRecord,
  officialNames: readonly OfficialNameEvidence[],
  searches: readonly TavilySearchResponse[],
): JsonRecord {
  const originalSourceNames = Array.isArray(operation.sourceNames)
    ? operation.sourceNames
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.replace(/^[・･]+|[・･]+$/gu, ""))
    : [];
  const sourceNames = dedupeText(
    originalSourceNames.map(stripCharacterRolePrefix),
  );
  const roleWasStripped = sourceNames.some(
    (name, index) => name !== originalSourceNames[index],
  );
  const targetName = stripKoreanCharacterRole(operation.targetName);
  const displayName = stripKoreanCharacterRole(operation.displayName);
  const primary = sourceNames[0];
  const evidenceSources = sourceNames.flatMap((name) =>
    findTextEvidenceSources(name, searches),
  );
  const correction = primary
    ? (findOfficialNameCorrection(primary, officialNames) ??
      findShortAliasSupportedNameCorrection(
        primary,
        sourceNames,
        officialNames,
        searches,
      ))
    : null;
  if (!correction) {
    const repairedTargetName = repairKatakanaNameMora(sourceNames, targetName);
    return {
      ...operation,
      sourceNames,
      targetName: repairedTargetName,
      displayName:
        displayName === targetName ? repairedTargetName : displayName,
      aliases: roleWasStripped
        ? dedupeText([
            ...originalSourceNames.filter(
              (name) => stripCharacterRolePrefix(name) !== name,
            ),
            ...readSourceAliases(operation.aliases),
          ])
        : operation.aliases,
      sources: mergeRawSources(operation.sources, evidenceSources),
    };
  }
  const aliases = Array.isArray(operation.aliases)
    ? operation.aliases.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const correctedSourceNames = [correction.name, ...sourceNames.slice(1)];
  const repairedTargetName = repairKatakanaNameMora(
    correctedSourceNames,
    targetName,
  );
  return {
    ...operation,
    sourceNames: correctedSourceNames,
    targetName: repairedTargetName,
    displayName: displayName === targetName ? repairedTargetName : displayName,
    aliases: dedupeText([primary, ...aliases]),
    sources: mergeRawSources(operation.sources, [
      ...correction.sources,
      ...evidenceSources,
    ]),
  };
}

const BASIC_KATAKANA_TO_HANGUL: Readonly<Record<string, string>> = {
  ア: "아",
  イ: "이",
  ウ: "우",
  エ: "에",
  オ: "오",
  カ: "카",
  キ: "키",
  ク: "쿠",
  ケ: "케",
  コ: "코",
  ガ: "가",
  ギ: "기",
  グ: "구",
  ゲ: "게",
  ゴ: "고",
  サ: "사",
  シ: "시",
  ス: "스",
  セ: "세",
  ソ: "소",
  ザ: "자",
  ジ: "지",
  ズ: "즈",
  ゼ: "제",
  ゾ: "조",
  タ: "타",
  チ: "치",
  ツ: "츠",
  テ: "테",
  ト: "토",
  ダ: "다",
  ヂ: "지",
  ヅ: "즈",
  デ: "데",
  ド: "도",
  ナ: "나",
  ニ: "니",
  ヌ: "누",
  ネ: "네",
  ノ: "노",
  ハ: "하",
  ヒ: "히",
  フ: "후",
  ヘ: "헤",
  ホ: "호",
  バ: "바",
  ビ: "비",
  ブ: "부",
  ベ: "베",
  ボ: "보",
  パ: "파",
  ピ: "피",
  プ: "푸",
  ペ: "페",
  ポ: "포",
  マ: "마",
  ミ: "미",
  ム: "무",
  メ: "메",
  モ: "모",
  ヤ: "야",
  ユ: "유",
  ヨ: "요",
  ラ: "라",
  リ: "리",
  ル: "루",
  レ: "레",
  ロ: "로",
  ワ: "와",
  ヰ: "위",
  ヱ: "웨",
  ヲ: "오",
} as const;

function repairKatakanaNameMora(
  sourceNames: readonly string[],
  value: unknown,
): unknown {
  if (typeof value !== "string") return value;
  const sourceParts = (sourceNames[0] ?? "").split("・");
  const targetParts = value.split(/\s+/u);
  if (sourceParts.length !== targetParts.length) return value;
  let changed = false;
  const repaired = sourceParts.map((sourcePart, partIndex) => {
    const targetPart = targetParts[partIndex] ?? "";
    const sourceCharacters = [...sourcePart];
    const targetCharacters = [...targetPart];
    if (
      !/^[ァ-ヺ]{2,8}$/u.test(sourcePart) ||
      !/^\p{Script=Hangul}{2,8}$/u.test(targetPart) ||
      sourceCharacters.length !== targetCharacters.length
    ) {
      return targetPart;
    }
    const expected = sourceCharacters.map(
      (character) => BASIC_KATAKANA_TO_HANGUL[character] ?? "",
    );
    if (expected.some((character) => !character)) return targetPart;
    const differingIndexes = targetCharacters.flatMap((character, index) =>
      character === expected[index] ? [] : [index],
    );
    if (differingIndexes.length !== 1) return targetPart;
    const index = differingIndexes[0] ?? -1;
    const introducedDuplicate =
      index > 0 &&
      targetCharacters[index] === targetCharacters[index - 1] &&
      sourceCharacters[index] !== sourceCharacters[index - 1];
    const introducedFinalConsonant = hasUnexpectedFinalConsonant(
      targetCharacters[index] ?? "",
      expected[index] ?? "",
    );
    if (!introducedDuplicate && !introducedFinalConsonant) return targetPart;
    changed = true;
    return expected.join("");
  });
  return changed ? repaired.join(" ") : value;
}

function hasUnexpectedFinalConsonant(
  target: string,
  expected: string,
): boolean {
  const hangulBase = 0xac00;
  const hangulEnd = 0xd7a3;
  const targetCode = target.codePointAt(0) ?? 0;
  const expectedCode = expected.codePointAt(0) ?? 0;
  if (
    targetCode < hangulBase ||
    targetCode > hangulEnd ||
    expectedCode < hangulBase ||
    expectedCode > hangulEnd
  ) {
    return false;
  }
  const targetOffset = targetCode - hangulBase;
  const expectedOffset = expectedCode - hangulBase;
  return (
    targetOffset % 28 !== 0 &&
    expectedOffset % 28 === 0 &&
    Math.floor(targetOffset / 28) === Math.floor(expectedOffset / 28)
  );
}

function findShortAliasSupportedNameCorrection(
  primary: string,
  names: readonly string[],
  officialNames: readonly OfficialNameEvidence[],
  searches: readonly TavilySearchResponse[],
): OfficialNameEvidence | null {
  const separatorIndex = primary.indexOf("・");
  if (separatorIndex < 2) return null;
  const suffix = primary.slice(separatorIndex);
  for (const shortName of names.slice(1)) {
    if (!/^[ァ-ヺー]{2,20}$/u.test(shortName)) continue;
    const candidate = `${shortName}${suffix}`;
    if (!editDistanceAtMostOne(primary, candidate)) continue;
    const official = officialNames.find((item) => item.name === candidate);
    if (official) return official;
    const sources = findTextEvidenceSources(candidate, searches);
    if (sources.length >= 2) {
      return { name: candidate, sources, authoritySignal: false };
    }
  }
  return null;
}

function stripCharacterRolePrefix(value: string): string {
  const match = value.match(
    /^(?:.{1,20}の)?(?:(?:最弱|最強|悪役|嫌われ|冷酷|没落|辺境)?(?:主人公|貴族|悪女|執事|幼馴染|少年|少女|青年|娘|息子|父|母|姉|妹|兄|弟|神|女神|英雄|王|王子|王女|皇子|皇女|皇帝|令嬢|騎士|冒険者|魔術師|剣聖|メイド|教師|学生|友人|仲間|ヒーロー|ヒロイン|ギルドマスター|隊長|団長|部長|社長|博士|不肖))[・･]?([ァ-ヺー]{3,20})$/u,
  );
  return match?.[1]?.replace(/^[・･]+/u, "") ?? value;
}

function trimKatakanaNameSeparators(value: string): string {
  return value.replace(/^[・･]+|[・･]+$/gu, "");
}

function stripKoreanCharacterRole(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const stripped = value
    .replace(
      /^(?:불초|주인공|악녀|집사|소꿉친구|소년|소녀|청년|딸|아들|아버지|어머니|누나|언니|여동생|형|오빠|남동생|신|여신|영웅|왕|왕자|왕녀|황자|황녀|황제|영애|기사|모험가|마술사|메이드|교사|학생|동료|히어로|히로인|대장|단장|부장|사장|박사)\s+/u,
      "",
    )
    .replace(
      /\s+(?:주인공|악녀|집사|소꿉친구|소년|소녀|청년|딸|아들|아버지|어머니|누나|언니|여동생|형|오빠|남동생|신|여신|영웅|왕|왕자|왕녀|황자|황녀|황제|영애|기사|모험가|마술사|메이드|교사|학생|동료|히어로|히로인|대장|단장|부장|사장|박사)$/u,
      "",
    )
    .trim();
  return stripped || value;
}

function buildMissingOfficialSpellingCorrections(
  operations: readonly unknown[],
  guide: WorkContextResearchPromptInput["guide"],
  officialNames: readonly OfficialNameEvidence[],
): JsonRecord[] {
  return guide.characters.flatMap((character) => {
    if (character.origin !== "ai") return [];
    const primary = character.sourceNames[0];
    const correction = primary
      ? findOfficialNameCorrection(primary, officialNames)
      : null;
    if (!correction || operationTargetsEntry(operations, character.id))
      return [];
    return [
      {
        entity: "character",
        action: "update",
        entryId: character.id,
        reason:
          "공식 출처 표기로 교정하고 기존 OCR 표기는 별칭으로 보존합니다.",
        confidence: "high",
        sources: correction.sources,
        source: null,
        target: null,
        category: null,
        aliases: dedupeText([primary, ...(character.aliases ?? [])]),
        note: character.note ?? null,
        displayName: character.displayName,
        sourceNames: [correction.name, ...character.sourceNames.slice(1)],
        targetName: character.targetName,
        speechStyle: character.speechStyle,
        customSpeechStyle: character.customSpeechStyle ?? null,
      },
    ];
  });
}

function buildObviousGenericCharacterDisableSuggestions(
  operations: readonly unknown[],
  guide: WorkContextResearchPromptInput["guide"],
): JsonRecord[] {
  return guide.characters.flatMap((character) => {
    if (
      character.origin !== "ai" ||
      !character.enabled ||
      operationTargetsEntry(operations, character.id)
    ) {
      return [];
    }
    const names = [
      ...character.sourceNames,
      ...(character.aliases ?? []),
    ].filter(Boolean);
    if (
      names.length === 0 ||
      !names.every(
        (name) =>
          looksLikeGenericCharacterLabel(name) ||
          looksLikeGenericKatakanaWebWord(name),
      )
    ) {
      return [];
    }
    return [
      {
        entity: "character",
        action: "disable",
        entryId: character.id,
        reason:
          "고유한 인명이 아니라 역할·관계·일반 표현으로 확인되어 캐릭터 항목 비활성화를 제안합니다.",
        confidence: "medium",
        sources: [],
        source: null,
        target: null,
        category: null,
        aliases: character.aliases ?? [],
        note: character.note ?? null,
        displayName: character.displayName,
        sourceNames: character.sourceNames,
        targetName: character.targetName,
        speechStyle: character.speechStyle,
        customSpeechStyle: character.customSpeechStyle ?? null,
      },
    ];
  });
}

function findOfficialNameCorrection(
  value: string,
  officialNames: readonly OfficialNameEvidence[],
): OfficialNameEvidence | null {
  if (!/^[ァ-ヺー・]{3,30}$/u.test(value)) return null;
  return (
    officialNames.find(
      (candidate) =>
        candidate.name !== value &&
        (editDistanceAtMostOne(value, candidate.name) ||
          isFullKatakanaNameExpansion(value, candidate.name)),
    ) ?? null
  );
}

function isFullKatakanaNameExpansion(shortName: string, fullName: string) {
  return (
    !shortName.includes("・") &&
    fullName.startsWith(`${shortName}・`) &&
    /^[ァ-ヺー]{2,}(?:・[ァ-ヺー]{2,})+$/u.test(fullName)
  );
}

function editDistanceAtMostOne(left: string, right: string): boolean {
  const leftChars = [...left];
  const rightChars = [...right];
  if (Math.abs(leftChars.length - rightChars.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < leftChars.length && rightIndex < rightChars.length) {
    if (leftChars[leftIndex] === rightChars[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (leftChars.length > rightChars.length) leftIndex += 1;
    else if (rightChars.length > leftChars.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return (
    edits +
      Number(leftIndex < leftChars.length || rightIndex < rightChars.length) ===
    1
  );
}

function operationTargetsEntry(
  operations: readonly unknown[],
  entryId: string,
): boolean {
  return operations.some((value) => readRecord(value)?.entryId === entryId);
}

function dedupeEvidenceOperations(
  values: readonly unknown[],
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): unknown[] {
  const titleOperations: JsonRecord[] = [];
  const byIdentity = new Map<string, JsonRecord>();
  for (const value of values) {
    const operation = readRecord(value);
    if (!operation) continue;
    if (isTranslatedTitleOperation(operation, input, searches)) {
      titleOperations.push(operation);
      continue;
    }
    const identity = operationIdentity(operation);
    const current = byIdentity.get(identity);
    byIdentity.set(
      identity,
      current
        ? mergeDuplicateEvidenceOperations(current, operation)
        : operation,
    );
  }
  const bestTitle = selectBestTitleOperation(titleOperations, searches, input);
  const operations = mergeAcronymGlossaryOperations(
    mergeEquivalentGlossarySpellings([...byIdentity.values()]),
  );
  const characterKeys = new Set(
    operations.flatMap((operation) =>
      operation.entity === "character" && Array.isArray(operation.sourceNames)
        ? operation.sourceNames
            .filter((name): name is string => typeof name === "string")
            .map(normalizeEvidenceKey)
        : [],
    ),
  );
  return [
    ...(bestTitle ? [bestTitle] : []),
    ...operations.filter(
      (operation) =>
        operation.entity !== "glossary" ||
        typeof operation.source !== "string" ||
        !characterKeys.has(normalizeEvidenceKey(operation.source)),
    ),
  ];
}

function mergeAcronymGlossaryOperations(
  operations: readonly JsonRecord[],
): JsonRecord[] {
  const claimedAbbreviations = new Set<JsonRecord>();
  const abbreviationByOwner = new Map<JsonRecord, JsonRecord>();
  for (const operation of [...operations].sort((left, right) => {
    const sourceLength = (value: JsonRecord) =>
      typeof value.source === "string" ? value.source.length : 0;
    return sourceLength(right) - sourceLength(left);
  })) {
    if (operation.entity !== "glossary") continue;
    const source = typeof operation.source === "string" ? operation.source : "";
    const acronym = buildLatinCompoundAcronym(source);
    if (!acronym) continue;
    const abbreviation = operations.find(
      (candidate) =>
        !claimedAbbreviations.has(candidate) &&
        candidate !== operation &&
        candidate.entity === "glossary" &&
        typeof candidate.source === "string" &&
        candidate.source.normalize("NFKC").toUpperCase() === acronym,
    );
    if (!abbreviation) continue;
    claimedAbbreviations.add(abbreviation);
    abbreviationByOwner.set(operation, abbreviation);
  }
  return operations.flatMap((operation) => {
    if (claimedAbbreviations.has(operation)) return [];
    if (operation.entity !== "glossary") return [operation];
    const abbreviation = abbreviationByOwner.get(operation);
    if (!abbreviation) return [operation];
    return [
      {
        ...operation,
        aliases: dedupeText([
          ...readSourceAliases(operation.aliases),
          abbreviation.source as string,
          ...readSourceAliases(abbreviation.aliases),
        ]),
        sources: mergeRawSources(
          operation.sources,
          readRawSources(abbreviation.sources),
        ),
      },
    ];
  });
}

function mergeEquivalentGlossarySpellings(
  operations: readonly JsonRecord[],
): JsonRecord[] {
  const merged: JsonRecord[] = [];
  for (const operation of [...operations].sort((left, right) => {
    const sourceLength = (value: JsonRecord) =>
      typeof value.source === "string" ? value.source.length : 0;
    return sourceLength(right) - sourceLength(left);
  })) {
    if (
      operation.entity !== "glossary" ||
      typeof operation.source !== "string" ||
      typeof operation.target !== "string"
    ) {
      merged.push(operation);
      continue;
    }
    const source = operation.source.normalize("NFKC");
    const target = normalizeEvidenceKey(operation.target);
    const sourceUrls = new Set(
      readRawSources(operation.sources).map((candidate) => candidate.url),
    );
    const ownerIndex = merged.findIndex((candidate) => {
      if (
        candidate.entity !== "glossary" ||
        typeof candidate.source !== "string" ||
        typeof candidate.target !== "string" ||
        candidate.category !== operation.category
      ) {
        return false;
      }
      const candidateSource = candidate.source.normalize("NFKC");
      if (
        source === candidateSource ||
        source.length < 3 ||
        candidateSource.length < 3 ||
        !editDistanceAtMostOne(source, candidateSource)
      ) {
        return false;
      }
      const candidateUrls = readRawSources(candidate.sources).map(
        (item) => item.url,
      );
      const shorterSource =
        source.length <= candidateSource.length ? source : candidateSource;
      const longerSource =
        source.length > candidateSource.length ? source : candidateSource;
      const terminalKatakanaAbbreviation =
        longerSource.length - shorterSource.length <= 2 &&
        longerSource.startsWith(shorterSource) &&
        /[ァ-ヺー]$/u.test(shorterSource) &&
        /[ァ-ヺー]$/u.test(longerSource);
      const candidateTarget = normalizeEvidenceKey(candidate.target);
      if (
        !terminalKatakanaAbbreviation &&
        candidateTarget !== target &&
        (candidateTarget.length < 3 ||
          target.length < 3 ||
          !editDistanceAtMostOne(candidateTarget, target))
      ) {
        return false;
      }
      return (
        terminalKatakanaAbbreviation ||
        sourceUrls.size === 0 ||
        candidateUrls.length === 0 ||
        candidateUrls.some((url) => sourceUrls.has(url))
      );
    });
    if (ownerIndex < 0) {
      merged.push(operation);
      continue;
    }
    const owner = merged[ownerIndex] as JsonRecord;
    merged[ownerIndex] = {
      ...owner,
      aliases: dedupeText([
        ...readSourceAliases(owner.aliases),
        operation.source,
        ...readSourceAliases(operation.aliases),
      ]),
      sources: mergeRawSources(
        owner.sources,
        readRawSources(operation.sources),
      ),
    };
  }
  return merged;
}

function buildLatinCompoundAcronym(value: string): string {
  const parts = value
    .normalize("NFKC")
    .split(/[・･·\s:_-]+/u)
    .filter(Boolean);
  if (
    parts.length < 2 ||
    !parts.every((part) => /^[A-Za-z][A-Za-z0-9]*$/u.test(part))
  ) {
    return "";
  }
  const acronym = parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
  return acronym.length >= 2 && acronym.length <= 8 ? acronym : "";
}

function isTranslatedTitleOperation(
  operation: JsonRecord,
  input: WorkContextResearchPromptInput,
  searches: readonly TavilySearchResponse[],
): boolean {
  if (
    operation.action !== "add" ||
    operation.entity !== "glossary" ||
    typeof operation.source !== "string"
  ) {
    return false;
  }
  if (operation.target === input.workTitle) return true;
  if (operation.category !== "other") return false;
  if (isResearchWorkTitleSource(operation.source, input, searches)) {
    return true;
  }
  return cachedTrustedEvidenceTitles(searches, input).some(
    (title) =>
      titleIdentitySimilarity(operation.source as string, title) >= 0.68,
  );
}

function selectBestTitleOperation(
  operations: readonly JsonRecord[],
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): JsonRecord | null {
  if (operations.length === 0) return null;
  const evidenceTitles = cachedEvidenceWorkTitles(searches, input).map(
    (candidate) => candidate.title,
  );
  return (
    [...operations].sort((left, right) => {
      const score = (operation: JsonRecord) => {
        const source =
          typeof operation.source === "string" ? operation.source : "";
        const similarity = Math.max(
          0,
          ...evidenceTitles.map((title) =>
            titleIdentitySimilarity(source, title),
          ),
        );
        const pageSuffixPenalty = /\s+(?:[-–—|｜/]\s+|公式$)/u.test(source)
          ? 300
          : 0;
        return (
          similarity * 1_000 +
          (operation.criticalTitleTranslation === true ? 5_000 : 0) +
          Math.min(operationTargetLength(operation), 180) * 4 +
          Math.min(source.length, 180) -
          pageSuffixPenalty
        );
      };
      return score(right) - score(left);
    })[0] ?? null
  );
}

function mergeDuplicateEvidenceOperations(
  left: JsonRecord,
  right: JsonRecord,
): JsonRecord {
  const preferred =
    operationTargetLength(right) > operationTargetLength(left) ? right : left;
  const secondary = preferred === left ? right : left;
  return {
    ...preferred,
    sources: mergeRawSources(
      preferred.sources,
      readRawSources(secondary.sources),
    ),
    aliases: dedupeText([
      ...(typeof secondary.source === "string" &&
      secondary.source !== preferred.source
        ? [secondary.source]
        : []),
      ...readSourceAliases(preferred.aliases),
      ...readSourceAliases(secondary.aliases),
    ]),
  };
}

function operationTargetLength(operation: JsonRecord): number {
  const target =
    operation.entity === "character" ? operation.targetName : operation.target;
  return typeof target === "string"
    ? normalizeLooseEvidenceKey(target).length
    : 0;
}

function readRawSources(value: unknown): Array<{ title: string; url: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const source = readRecord(candidate);
    return typeof source?.url === "string" && typeof source.title === "string"
      ? [{ title: source.title, url: source.url }]
      : [];
  });
}

function mergeRawSources(
  value: unknown,
  additions: Array<{ title: string; url: string }>,
): Array<{ title: string; url: string }> {
  const existing = Array.isArray(value)
    ? value.flatMap((candidate) => {
        const source = readRecord(candidate);
        return typeof source?.url === "string" &&
          typeof source.title === "string"
          ? [{ title: source.title, url: source.url }]
          : [];
      })
    : [];
  const seen = new Set<string>();
  return [...additions, ...existing].filter((source) => {
    if (seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function collectEvidenceReadings(
  searches: readonly TavilySearchResponse[],
  input: WorkContextResearchPromptInput,
): Map<string, string[]> {
  const readings = new Map<string, string[]>();
  for (const { result } of cachedWorkBoundResults(searches, input)) {
    const text = `${result.title}\n${result.content}`;
    for (const match of text.matchAll(
      /([\p{Script=Han}々〆ヶ]{1,30})[（(]([ァ-ヺー・]{2,40})[）)]/gu,
    )) {
      const source = match[1] ?? "";
      const reading = match[2] ?? "";
      const key = normalizeEvidenceKey(source);
      if (!key || !reading) continue;
      readings.set(key, dedupeText([...(readings.get(key) ?? []), reading]));
    }
  }
  return readings;
}

function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function normalizeEvidenceKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
}

function normalizeLooseEvidenceKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .toLocaleLowerCase();
}

function dedupeText(values: string[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const text = value.replace(/\s+/g, " ").trim().slice(0, 400);
    const key = text.normalize("NFKC").toLocaleLowerCase();
    if (!text || seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}
