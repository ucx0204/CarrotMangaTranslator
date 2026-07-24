// @ts-check

const {
  cleanText,
  isRecord,
  parseJsonObject,
  semanticContractError,
} = require("./values.cjs");
const {
  findFixedBlockTargetLanguageViolations,
  validateFixedBlockTargetLanguage,
} = require("./fixed-block-quality.cjs");

/**
 * @typedef {{blockId:string;ko:string}} FixedBlockTranslation
 * @typedef {{items:FixedBlockTranslation[];pageContext?:Record<string,unknown>}} FixedBlockTranslationResult
 * @typedef {{blocks:Array<{blockId:string}>}} FixedBlockPlan
 * @typedef {{sourceLanguage?:unknown;targetLanguage?:unknown;collectPageContext?:unknown;[key:string]:unknown}} FixedBlockOptions
 * @typedef {{translations:FixedBlockTranslationResult;retryBlockIds:string[]}} FixedBlockPartialResult
 */

/**
 * @param {string} rawText
 * @param {FixedBlockPlan} plan
 * @param {FixedBlockOptions} [options]
 * @returns {FixedBlockTranslationResult}
 */
function parseFixedBlockTranslationResponse(rawText, plan, options = {}) {
  const parsed = parseFixedBlockTranslationDraft(rawText, plan, options);
  validateFixedBlockTargetLanguage(parsed.items, options);
  return parsed;
}

/**
 * Strict parser retained for callers that require the complete immutable
 * response contract before using any item.
 *
 * @param {string} rawText
 * @param {FixedBlockPlan} plan
 * @param {FixedBlockOptions} [options]
 * @returns {FixedBlockTranslationResult}
 */
function parseFixedBlockTranslationDraft(rawText, plan, options = {}) {
  const raw = parseJsonObject(rawText, "Fixed-block translation");
  validateTopLevelKeys(raw, options);
  const rawItems = requireItemsArray(raw);
  const items = rawItems.map(readFixedBlockTranslation);
  const expectedIds = plan.blocks.map((block) => block.blockId);
  validateFixedBlockPartition(items, expectedIds);
  validateFixedBlockOrder(items, expectedIds);
  if ("pageContext" in raw && !isRecord(raw.pageContext)) {
    throw semanticContractError(
      "fixed-block-translation-page-context-invalid",
      "Fixed-block translation pageContext must be an object.",
    );
  }
  const pageContext = isRecord(raw.pageContext) ? raw.pageContext : undefined;
  return { items, ...(pageContext ? { pageContext } : {}) };
}

/**
 * Salvage independently valid items from a structurally readable response.
 * An item is trusted only when its expected blockId is claimed exactly once
 * and the complete item passes the immutable two-field contract. Missing,
 * duplicated, malformed, unexpected, and source-script-leaking items become
 * targeted retry ids without affecting any accepted block.
 *
 * Invalid JSON or a response without an items array still throws because no
 * reliable block ownership can be recovered from it.
 *
 * @param {string} rawText
 * @param {FixedBlockPlan} plan
 * @param {FixedBlockOptions} [options]
 * @returns {FixedBlockPartialResult}
 */
function parseFixedBlockTranslationPartialResponse(
  rawText,
  plan,
  options = {},
) {
  const raw = parseJsonObject(rawText, "Fixed-block translation");
  const rawItems = requireItemsArray(raw);
  const expectedIds = plan.blocks.map((block) => block.blockId);
  const expectedIdSet = new Set(expectedIds);
  const claimCounts = countExpectedBlockIdClaims(rawItems, expectedIdSet);
  const validById = collectUniqueValidItems(
    rawItems,
    expectedIdSet,
    claimCounts,
  );
  const orderedItems = readItemsInOrder(expectedIds, validById);
  const violationIds = new Set(
    findFixedBlockTargetLanguageViolations(orderedItems, options).map(
      (item) => item.blockId,
    ),
  );
  const items = orderedItems.filter((item) => !violationIds.has(item.blockId));
  const acceptedIds = new Set(items.map((item) => item.blockId));
  const pageContext = readOptionalPageContext(raw, options);
  return {
    translations: { items, ...(pageContext ? { pageContext } : {}) },
    retryBlockIds: expectedIds.filter((blockId) => !acceptedIds.has(blockId)),
  };
}

/**
 * Preserve accepted strings and page context while inserting newly recovered
 * blocks in immutable plan order when that order is supplied.
 *
 * @param {FixedBlockTranslationResult} current
 * @param {FixedBlockTranslationResult} repaired
 * @param {string[]} [expectedIds]
 * @returns {FixedBlockTranslationResult}
 */
function mergeFixedBlockTranslationResults(
  current,
  repaired,
  expectedIds = [],
) {
  const mergedById = new Map(
    [...current.items, ...repaired.items].map((item) => [item.blockId, item]),
  );
  const currentIds = new Set(current.items.map((item) => item.blockId));
  const itemOrder =
    expectedIds.length > 0
      ? expectedIds
      : [
          ...currentIds,
          ...repaired.items
            .map((item) => item.blockId)
            .filter((blockId) => !currentIds.has(blockId)),
        ];
  return {
    items: readItemsInOrder(itemOrder, mergedById),
    ...(current.pageContext ? { pageContext: current.pageContext } : {}),
  };
}

/** @param {Record<string,unknown>} raw @param {FixedBlockOptions} options */
function validateTopLevelKeys(raw, options) {
  const allowedKeys = options.collectPageContext
    ? ["items", "pageContext"]
    : ["items"];
  const unexpectedKeys = Object.keys(raw).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpectedKeys.length === 0) return;
  throw semanticContractError(
    "fixed-block-translation-extra-top-level-fields",
    `Fixed-block translation contains forbidden top-level fields: ${unexpectedKeys.join(", ")}.`,
  );
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
 * @param {unknown[]} rawItems
 * @param {Set<string>} expectedIds
 * @param {Map<string,number>} claimCounts
 * @returns {Map<string,FixedBlockTranslation>}
 */
function collectUniqueValidItems(rawItems, expectedIds, claimCounts) {
  const validById = new Map();
  for (const [index, value] of rawItems.entries()) {
    if (!isRecord(value) || typeof value.blockId !== "string") continue;
    const blockId = value.blockId.trim();
    if (!expectedIds.has(blockId) || claimCounts.get(blockId) !== 1) continue;
    try {
      const item = readFixedBlockTranslation(value, index);
      validById.set(item.blockId, item);
    } catch (error) {
      if (!isFixedBlockItemContractError(error)) throw error;
    }
  }
  return validById;
}

/** @param {unknown} error */
function isFixedBlockItemContractError(error) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code ?? "")
      : "";
  return code.startsWith("fixed-block-translation-");
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

/** @param {unknown} value @param {number} index @returns {FixedBlockTranslation} */
function readFixedBlockTranslation(value, index) {
  if (!isRecord(value)) {
    throw semanticContractError(
      "fixed-block-translation-invalid",
      `Fixed-block translation ${index + 1} is not an object.`,
    );
  }
  const unexpectedKeys = Object.keys(value).filter(
    (key) => !["blockId", "ko"].includes(key),
  );
  if (unexpectedKeys.length > 0) {
    throw semanticContractError(
      "fixed-block-translation-extra-fields",
      `Fixed-block translation ${index + 1} contains forbidden fields: ${unexpectedKeys.join(", ")}.`,
    );
  }
  const blockId = String(value.blockId ?? "").trim();
  if (
    typeof value.ko === "string" &&
    (/[\r\n]/u.test(value.ko) || /\\[nr]/u.test(value.ko))
  ) {
    throw semanticContractError(
      "fixed-block-translation-ko-multiline",
      `Fixed-block translation ${index + 1} ko must be a single line.`,
    );
  }
  const ko = cleanText(value.ko, 8000);
  if (!/^B\d{3,4}$/.test(blockId) || typeof value.ko !== "string") {
    throw semanticContractError(
      "fixed-block-translation-incomplete",
      `Fixed-block translation ${index + 1} is missing blockId or ko.`,
    );
  }
  if (!ko) {
    throw semanticContractError(
      "fixed-block-translation-empty-text",
      `Fixed-block translation ${index + 1} must return non-empty ko.`,
    );
  }
  return { blockId, ko };
}

/** @param {FixedBlockTranslation[]} items @param {string[]} expectedIds */
function validateFixedBlockPartition(items, expectedIds) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.blockId, (counts.get(item.blockId) ?? 0) + 1);
  }
  const unexpected = [...counts.keys()].filter(
    (blockId) => !expectedIds.includes(blockId),
  );
  const missing = expectedIds.filter((blockId) => !counts.has(blockId));
  const duplicate = [...counts.entries()]
    .filter(([, count]) => count !== 1)
    .map(([blockId]) => blockId);
  if (!unexpected.length && !missing.length && !duplicate.length) return;
  throw semanticContractError(
    "fixed-block-translation-partition",
    `Fixed-block translation ids failed: unexpected=[${unexpected.join(",")}], duplicate=[${duplicate.join(",")}], missing=[${missing.join(",")}].`,
  );
}

/** @param {FixedBlockTranslation[]} items @param {string[]} expectedIds */
function validateFixedBlockOrder(items, expectedIds) {
  const actualIds = items.map((item) => item.blockId);
  if (actualIds.every((blockId, index) => blockId === expectedIds[index])) {
    return;
  }
  throw semanticContractError(
    "fixed-block-translation-order",
    `Fixed-block translation order failed: expected=[${expectedIds.join(",")}], actual=[${actualIds.join(",")}].`,
  );
}

module.exports = {
  mergeFixedBlockTranslationResults,
  parseFixedBlockTranslationDraft,
  parseFixedBlockTranslationPartialResponse,
  parseFixedBlockTranslationResponse,
};
