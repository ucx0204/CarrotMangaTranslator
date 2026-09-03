// @ts-check

const {
  cleanText,
  isRecord,
  parseJsonObject,
  semanticContractError,
} = require("./values.cjs");
const {
  findFixedBlockTargetLanguageViolations,
} = require("./fixed-block-quality.cjs");
const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");

/**
 * @typedef {{blockId:string;ko:string;textRole?:"ordinary"|"sound";layoutIntent?:"horizontal"|"vertical";fontRole?:string;fontRoleConfidence?:number;visualClusterId?:string}} FixedBlockTranslation
 * @typedef {{items:FixedBlockTranslation[];pageContext?:Record<string,unknown>}} FixedBlockTranslationResult
 * @typedef {{blocks:Array<{blockId:string}>}} FixedBlockPlan
 * @typedef {{sourceLanguage?:unknown;targetLanguage?:unknown;collectPageContext?:unknown;autoFontMatching?:unknown;[key:string]:unknown}} FixedBlockOptions
 * @typedef {(value:unknown,index:number,options:FixedBlockOptions)=>FixedBlockTranslation} FixedBlockItemReader
 * @typedef {{translations:FixedBlockTranslationResult;retryBlockIds:string[];retryReasons:Record<string,string[]>;horizontalFallbackTranslations?:FixedBlockTranslationResult;fontIntentFallbackTranslations?:FixedBlockTranslationResult;targetTypographyFallbackTranslations?:FixedBlockTranslationResult;sourceScriptFallbackTranslations?:FixedBlockTranslationResult;readableTextFallbackTranslations?:FixedBlockTranslationResult}} FixedBlockPartialResult
 */

/**
 * Salvage independently valid items from a structurally readable response and
 * retain only narrowly safe presentation fallbacks for exhausted retries.
 *
 * @param {string} rawText
 * @param {FixedBlockPlan} plan
 * @param {FixedBlockOptions} options
 * @param {FixedBlockItemReader} readItem
 * @returns {FixedBlockPartialResult}
 */
function parseFixedBlockTranslationPartialResponse(
  rawText,
  plan,
  options,
  readItem,
) {
  const raw = parseJsonObject(rawText, "Fixed-block translation");
  const rawItems = requireItemsArray(raw);
  const expectedIds = plan.blocks.map((block) => block.blockId);
  const expectedIdSet = new Set(expectedIds);
  const claimCounts = countExpectedBlockIdClaims(rawItems, expectedIdSet);
  const retryReasonById = createInitialRetryReasonIndex(
    expectedIds,
    claimCounts,
  );
  const candidates = collectUniqueValidItems(
    rawItems,
    expectedIdSet,
    claimCounts,
    options,
    retryReasonById,
    readItem,
  );
  const primary = partitionByTargetLanguage(
    readItemsInOrder(expectedIds, candidates.validById),
    options,
  );
  recordLanguageViolations(retryReasonById, primary.rejected);
  const horizontal = partitionByTargetLanguage(
    readItemsInOrder(expectedIds, candidates.horizontalFallbackById),
    options,
  );
  const fontIntent = partitionByTargetLanguage(
    readItemsInOrder(expectedIds, candidates.fontIntentFallbackById),
    options,
  );
  const targetTypography = buildTargetTypographyFallbackItems(
    [...primary.rejected, ...horizontal.rejected, ...fontIntent.rejected],
    options,
  );
  const targetTypographyIds = new Set(
    targetTypography.map((item) => item.blockId),
  );
  const sourceScript = uniqueItemsByBlockId([
    ...primary.rejected,
    ...horizontal.rejected,
    ...fontIntent.rejected,
  ]).filter((item) => !targetTypographyIds.has(item.blockId));
  const specializedFallbackIds = new Set(
    [
      ...primary.accepted,
      ...horizontal.accepted,
      ...fontIntent.accepted,
      ...targetTypography,
      ...sourceScript,
    ].map((item) => item.blockId),
  );
  const readableText = buildReadableTextFallbackItems(
    rawItems,
    expectedIdSet,
    specializedFallbackIds,
  );
  return buildPartialResult({
    expectedIds,
    items: primary.accepted,
    pageContext: readOptionalPageContext(raw, options),
    retryReasonById,
    horizontal: horizontal.accepted,
    fontIntent: fontIntent.accepted,
    targetTypography,
    sourceScript,
    readableText,
  });
}

/**
 * @param {{expectedIds:string[];items:FixedBlockTranslation[];pageContext:Record<string,unknown>|undefined;retryReasonById:Map<string,Set<string>>;horizontal:FixedBlockTranslation[];fontIntent:FixedBlockTranslation[];targetTypography:FixedBlockTranslation[];sourceScript:FixedBlockTranslation[];readableText:FixedBlockTranslation[]}} value
 * @returns {FixedBlockPartialResult}
 */
function buildPartialResult(value) {
  const acceptedIds = new Set(value.items.map((item) => item.blockId));
  const retryBlockIds = value.expectedIds.filter(
    (blockId) => !acceptedIds.has(blockId),
  );
  return {
    translations: {
      items: value.items,
      ...(value.pageContext ? { pageContext: value.pageContext } : {}),
    },
    retryBlockIds,
    retryReasons: Object.fromEntries(
      retryBlockIds.map((blockId) => [
        blockId,
        [
          ...(value.retryReasonById.get(blockId) ?? [
            "fixed-block-translation-missing",
          ]),
        ],
      ]),
    ),
    ...asFallbackResult("horizontalFallbackTranslations", value.horizontal),
    ...asFallbackResult("fontIntentFallbackTranslations", value.fontIntent),
    ...asFallbackResult(
      "targetTypographyFallbackTranslations",
      value.targetTypography,
    ),
    ...asFallbackResult("sourceScriptFallbackTranslations", value.sourceScript),
    ...asFallbackResult("readableTextFallbackTranslations", value.readableText),
  };
}

/** @param {string} key @param {FixedBlockTranslation[]} items */
function asFallbackResult(key, items) {
  return items.length > 0 ? { [key]: { items } } : {};
}

/**
 * @param {FixedBlockTranslation[]} items
 * @param {FixedBlockOptions} options
 */
function partitionByTargetLanguage(items, options) {
  const violationIds = new Set(
    findFixedBlockTargetLanguageViolations(items, options).map(
      (item) => item.blockId,
    ),
  );
  return {
    accepted: items.filter((item) => !violationIds.has(item.blockId)),
    rejected: items.filter((item) => violationIds.has(item.blockId)),
  };
}

/**
 * @param {Map<string,Set<string>>} retryReasonById
 * @param {FixedBlockTranslation[]} items
 */
function recordLanguageViolations(retryReasonById, items) {
  for (const { blockId } of items) {
    addRetryReason(
      retryReasonById,
      blockId,
      "fixed-block-translation-source-script-leak",
    );
  }
}

/** @param {Record<string,unknown>} raw @returns {unknown[]} */
function requireItemsArray(raw) {
  if (Array.isArray(raw.items)) return raw.items;
  throw semanticContractError(
    "fixed-block-translations-invalid",
    "Fixed-block translation must return an items array.",
  );
}

/**
 * @param {unknown[]} rawItems
 * @param {Set<string>} expectedIds
 * @returns {Map<string,number>}
 */
function countExpectedBlockIdClaims(rawItems, expectedIds) {
  const counts = new Map();
  for (const value of rawItems) {
    if (!isRecord(value) || typeof value.blockId !== "string") continue;
    const blockId = value.blockId.trim();
    if (!expectedIds.has(blockId)) continue;
    counts.set(blockId, (counts.get(blockId) ?? 0) + 1);
  }
  return counts;
}

/**
 * @param {string[]} expectedIds
 * @param {Map<string,number>} claimCounts
 * @returns {Map<string,Set<string>>}
 */
function createInitialRetryReasonIndex(expectedIds, claimCounts) {
  const reasons = new Map();
  for (const blockId of expectedIds) {
    const claimCount = claimCounts.get(blockId) ?? 0;
    if (claimCount === 0) {
      addRetryReason(reasons, blockId, "fixed-block-translation-missing");
    } else if (claimCount > 1) {
      addRetryReason(reasons, blockId, "fixed-block-translation-duplicate");
    }
  }
  return reasons;
}

/** @param {Map<string,Set<string>>} reasons @param {string} blockId @param {string} code */
function addRetryReason(reasons, blockId, code) {
  const current = reasons.get(blockId) ?? new Set();
  current.add(code);
  reasons.set(blockId, current);
}

/**
 * @param {unknown[]} rawItems
 * @param {Set<string>} expectedIds
 * @param {Map<string,number>} claimCounts
 * @param {FixedBlockOptions} options
 * @param {Map<string,Set<string>>} retryReasonById
 * @param {FixedBlockItemReader} readItem
 */
function collectUniqueValidItems(
  rawItems,
  expectedIds,
  claimCounts,
  options,
  retryReasonById,
  readItem,
) {
  const validById = new Map();
  const horizontalFallbackById = new Map();
  const fontIntentFallbackById = new Map();
  for (const [index, value] of rawItems.entries()) {
    if (!isRecord(value) || typeof value.blockId !== "string") continue;
    const blockId = value.blockId.trim();
    if (!expectedIds.has(blockId) || claimCounts.get(blockId) !== 1) continue;
    try {
      const item = readItem(value, index, options);
      validById.set(item.blockId, item);
    } catch (error) {
      if (!isFixedBlockItemContractError(error)) throw error;
      addRetryReason(
        retryReasonById,
        blockId,
        readFixedBlockContractErrorCode(error),
      );
      const horizontal = readHorizontalLayoutFallbackTranslation(
        value,
        index,
        options,
        error,
        readItem,
      );
      if (horizontal)
        horizontalFallbackById.set(horizontal.blockId, horizontal);
      const fontIntent = readNeutralFontIntentFallbackTranslation(
        value,
        index,
        options,
        error,
        readItem,
      );
      if (fontIntent)
        fontIntentFallbackById.set(fontIntent.blockId, fontIntent);
    }
  }
  return { validById, horizontalFallbackById, fontIntentFallbackById };
}

/**
 * Preserve valid text when audit-only font metadata contradicts the coarse
 * role, while making the fine role explicitly unavailable to selection.
 *
 * @param {Record<string,unknown>} value
 * @param {number} index
 * @param {FixedBlockOptions} options
 * @param {unknown} originalError
 * @param {FixedBlockItemReader} readItem
 * @returns {FixedBlockTranslation|null}
 */
function readNeutralFontIntentFallbackTranslation(
  value,
  index,
  options,
  originalError,
  readItem,
) {
  const code = readFixedBlockContractErrorCode(originalError);
  if (
    options.autoFontMatching !== true ||
    (code !== "fixed-block-translation-font-role-conflict" &&
      code !== "fixed-block-translation-font-role-invalid")
  ) {
    return null;
  }
  return tryReadFallback(
    {
      ...value,
      ...(value.layoutIntent === "vertical"
        ? { layoutIntent: "horizontal" }
        : {}),
      fontRole: "unknown_needs_review",
      fontRoleConfidence: 0,
    },
    index,
    options,
    readItem,
  );
}

/**
 * Convert only the Japanese prolonged-sound glyph used as Korean emphasis.
 * Any remaining kana or kanji still fails the target-language check.
 *
 * @param {FixedBlockTranslation[]} candidates
 * @param {FixedBlockOptions} options
 * @returns {FixedBlockTranslation[]}
 */
function buildTargetTypographyFallbackItems(candidates, options) {
  const profile = resolvePromptLanguageProfile(options);
  if (profile.sourceBaseCode !== "ja" || profile.targetBaseCode !== "ko") {
    return [];
  }
  const recoveredById = new Map();
  for (const item of candidates) {
    if (!item.ko.includes("ー")) continue;
    const recovered = { ...item, ko: item.ko.replace(/ー/gu, "~") };
    if (findFixedBlockTargetLanguageViolations([recovered], options).length) {
      continue;
    }
    recoveredById.set(recovered.blockId, recovered);
  }
  return [...recoveredById.values()];
}

/**
 * Retain a readable target string even when duplicate claims or advisory
 * metadata make the complete item contract invalid. This value is never used
 * until targeted repairs are exhausted, and the completed block is marked for
 * review by the pipeline.
 *
 * @param {unknown[]} rawItems
 * @param {Set<string>} expectedIds
 * @param {Set<string>} specializedFallbackIds
 * @returns {FixedBlockTranslation[]}
 */
function buildReadableTextFallbackItems(
  rawItems,
  expectedIds,
  specializedFallbackIds,
) {
  const fallbackById = new Map();
  for (const value of rawItems) {
    if (!isRecord(value) || typeof value.blockId !== "string") continue;
    const blockId = value.blockId.trim();
    if (!expectedIds.has(blockId) || specializedFallbackIds.has(blockId)) {
      continue;
    }
    const ko = normalizeReadableFallbackText(value.ko);
    if (!ko || fallbackById.has(blockId)) continue;
    fallbackById.set(blockId, { blockId, ko });
  }
  return [...fallbackById.values()];
}

/** @param {unknown} value */
function normalizeReadableFallbackText(value) {
  return cleanText(value, 8000)
    .replace(/\\[nr]|[\r\n]/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

/** @param {FixedBlockTranslation[]} items */
function uniqueItemsByBlockId(items) {
  return [...new Map(items.map((item) => [item.blockId, item])).values()];
}

/**
 * @param {Record<string,unknown>} value
 * @param {number} index
 * @param {FixedBlockOptions} options
 * @param {unknown} originalError
 * @param {FixedBlockItemReader} readItem
 * @returns {FixedBlockTranslation|null}
 */
function readHorizontalLayoutFallbackTranslation(
  value,
  index,
  options,
  originalError,
  readItem,
) {
  if (
    readFixedBlockContractErrorCode(originalError) !==
    "fixed-block-translation-layout-intent-font-role-conflict"
  ) {
    return null;
  }
  return tryReadFallback(
    { ...value, layoutIntent: "horizontal" },
    index,
    options,
    readItem,
  );
}

/**
 * @param {Record<string,unknown>} value
 * @param {number} index
 * @param {FixedBlockOptions} options
 * @param {FixedBlockItemReader} readItem
 */
function tryReadFallback(value, index, options, readItem) {
  try {
    return readItem(value, index, options);
  } catch (error) {
    if (!isFixedBlockItemContractError(error)) throw error;
    return null;
  }
}

/** @param {unknown} error */
function isFixedBlockItemContractError(error) {
  return readFixedBlockContractErrorCode(error).startsWith(
    "fixed-block-translation-",
  );
}

/** @param {unknown} error */
function readFixedBlockContractErrorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? String(error.code ?? "")
    : "fixed-block-translation-invalid";
}

/**
 * @param {string[]} ids
 * @param {Map<string,FixedBlockTranslation>} itemsById
 * @returns {FixedBlockTranslation[]}
 */
function readItemsInOrder(ids, itemsById) {
  return ids.flatMap((blockId) => {
    const item = itemsById.get(blockId);
    return item ? [item] : [];
  });
}

/** @param {Record<string,unknown>} raw @param {FixedBlockOptions} options */
function readOptionalPageContext(raw, options) {
  if (!options.collectPageContext || !isRecord(raw.pageContext)) {
    return undefined;
  }
  return raw.pageContext;
}

module.exports = { parseFixedBlockTranslationPartialResponse };
