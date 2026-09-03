// @ts-check

const {
  cleanText,
  isRecord,
  parseJsonObject,
  semanticContractError,
} = require("./values.cjs");
const {
  validateFixedBlockTargetLanguage,
} = require("./fixed-block-quality.cjs");
const {
  parseFixedBlockTranslationPartialResponse: parseFixedBlockPartialResponse,
} = require("./fixed-block-partial-response.cjs");
const {
  isFontRoleCompatibleWithTextRole,
  normalizeFontRole,
  normalizeFontRoleConfidence,
} = require("../font-matching-intent.cjs");
const { normalizeVisualClusterId } = require("../visual-cluster-id.cjs");

const MIN_VERTICAL_LAYOUT_FONT_ROLE_CONFIDENCE = 0.82;

/**
 * @typedef {{blockId:string;ko:string;textRole?:"ordinary"|"sound";layoutIntent?:"horizontal"|"vertical";fontRole?:string;fontRoleConfidence?:number;visualClusterId?:string}} FixedBlockTranslation
 * @typedef {{items:FixedBlockTranslation[];pageContext?:Record<string,unknown>}} FixedBlockTranslationResult
 * @typedef {{blocks:Array<{blockId:string}>}} FixedBlockPlan
 * @typedef {{sourceLanguage?:unknown;targetLanguage?:unknown;collectPageContext?:unknown;autoFontMatching?:unknown;[key:string]:unknown}} FixedBlockOptions
 * @typedef {{translations:FixedBlockTranslationResult;retryBlockIds:string[];retryReasons:Record<string,string[]>;horizontalFallbackTranslations?:FixedBlockTranslationResult;fontIntentFallbackTranslations?:FixedBlockTranslationResult;targetTypographyFallbackTranslations?:FixedBlockTranslationResult;sourceScriptFallbackTranslations?:FixedBlockTranslationResult;readableTextFallbackTranslations?:FixedBlockTranslationResult}} FixedBlockPartialResult
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
 * response contract before using any item. The parser still accepts legacy
 * two-field fixtures/results without textRole as ordinary; the runtime JSON
 * schema requires textRole for every newly generated response.
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
  const items = rawItems.map((item, index) =>
    readFixedBlockTranslation(item, index, options),
  );
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
 * and the complete item passes the immutable text contract. Missing,
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
  return parseFixedBlockPartialResponse(
    rawText,
    plan,
    options,
    readFixedBlockTranslation,
  );
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

/** @param {unknown} value @param {number} index @param {FixedBlockOptions} options @returns {FixedBlockTranslation} */
function readFixedBlockTranslation(value, index, options = {}) {
  if (!isRecord(value)) {
    throw semanticContractError(
      "fixed-block-translation-invalid",
      `Fixed-block translation ${index + 1} is not an object.`,
    );
  }
  const allowedKeys = options.autoFontMatching
    ? [
        "blockId",
        "textRole",
        "layoutIntent",
        "fontRole",
        "fontRoleConfidence",
        "visualClusterId",
        "visual_cluster_id",
        "ko",
      ]
    : ["blockId", "textRole", "layoutIntent", "ko"];
  const unexpectedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unexpectedKeys.length > 0) {
    throw semanticContractError(
      "fixed-block-translation-extra-fields",
      `Fixed-block translation ${index + 1} contains forbidden fields: ${unexpectedKeys.join(", ")}.`,
    );
  }
  const blockId = String(value.blockId ?? "").trim();
  const textRole = readFixedBlockTextRole(value.textRole, index);
  const layoutIntent = readFixedBlockLayoutIntent(value.layoutIntent, index);
  const fontIntent = readFixedBlockFontIntent(value, index, options, textRole);
  validateFixedBlockLayoutFontRole(layoutIntent, fontIntent, index, options);
  const visualClusterId = readFixedBlockVisualClusterId(value, options);
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
  return buildFixedBlockTranslation(
    blockId,
    ko,
    textRole,
    layoutIntent,
    fontIntent,
    visualClusterId,
  );
}

/**
 * Missing legacy values and explicit auto both preserve automatic behavior.
 * An explicitly malformed current value is a targeted item contract failure.
 * @param {unknown} value
 * @param {number} index
 * @returns {"horizontal"|"vertical"|undefined}
 */
function readFixedBlockLayoutIntent(value, index) {
  if (value === undefined || value === "auto") return undefined;
  if (value === "horizontal" || value === "vertical") return value;
  throw semanticContractError(
    "fixed-block-translation-layout-intent-invalid",
    `Fixed-block translation ${index + 1} layoutIntent must be auto, horizontal, or vertical.`,
  );
}

/** @param {Record<string,unknown>} value @param {FixedBlockOptions} options */
function readFixedBlockVisualClusterId(value, options) {
  if (!options.autoFontMatching) return undefined;
  return normalizeVisualClusterId(
    value.visualClusterId ?? value.visual_cluster_id,
  );
}

/** @param {Record<string,unknown>} value @param {number} index @param {FixedBlockOptions} options @param {"ordinary"|"sound"|undefined} textRole */
function readFixedBlockFontIntent(value, index, options, textRole) {
  if (!options.autoFontMatching) return undefined;
  const fontRole = normalizeFontRole(value.fontRole);
  const fontRoleConfidence = normalizeFontRoleConfidence(
    value.fontRoleConfidence,
  );
  if (!fontRole || fontRoleConfidence === undefined) {
    throw semanticContractError(
      "fixed-block-translation-font-role-invalid",
      `Fixed-block translation ${index + 1} must return a valid fontRole and fontRoleConfidence.`,
    );
  }
  if (!isFontRoleCompatibleWithTextRole(textRole, fontRole)) {
    throw semanticContractError(
      "fixed-block-translation-font-role-conflict",
      `Fixed-block translation ${index + 1} fontRole conflicts with textRole.`,
    );
  }
  return { fontRole, fontRoleConfidence };
}

/**
 * A vertical rendering advisory needs narration evidence produced by this
 * exact v6 response. Persisted roles are deliberately unavailable here. Treat
 * missing, disabled, conflicting, or low-confidence evidence as an item-local
 * contract failure so the partial parser can request a targeted correction.
 *
 * @param {"horizontal"|"vertical"|undefined} layoutIntent
 * @param {{fontRole:string;fontRoleConfidence:number}|undefined} fontIntent
 * @param {number} index
 * @param {FixedBlockOptions} options
 */
function validateFixedBlockLayoutFontRole(
  layoutIntent,
  fontIntent,
  index,
  options,
) {
  if (layoutIntent !== "vertical") return;
  if (
    options.autoFontMatching === true &&
    fontIntent?.fontRole === "narration" &&
    Number.isFinite(fontIntent.fontRoleConfidence) &&
    fontIntent.fontRoleConfidence >= MIN_VERTICAL_LAYOUT_FONT_ROLE_CONFIDENCE
  )
    return;
  throw semanticContractError(
    "fixed-block-translation-layout-intent-font-role-conflict",
    `Fixed-block translation ${index + 1} layoutIntent vertical requires autoFontMatching with fontRole narration and finite fontRoleConfidence >= ${MIN_VERTICAL_LAYOUT_FONT_ROLE_CONFIDENCE}.`,
  );
}

/**
 * @param {unknown} value
 * @param {number} index
 * @returns {"ordinary"|"sound"|undefined}
 */
function readFixedBlockTextRole(value, index) {
  if (value === undefined) return undefined;
  const textRole = String(value ?? "")
    .trim()
    .toLowerCase();
  if (textRole === "ordinary" || textRole === "sound") return textRole;
  throw semanticContractError(
    "fixed-block-translation-role-invalid",
    `Fixed-block translation ${index + 1} textRole must be ordinary or sound.`,
  );
}

/**
 * @param {string} blockId
 * @param {string} ko
 * @param {"ordinary"|"sound"|undefined} textRole
 * @param {"horizontal"|"vertical"|undefined} layoutIntent
 * @param {{fontRole:string;fontRoleConfidence:number}|undefined} fontIntent
 * @param {string|undefined} visualClusterId
 * @returns {FixedBlockTranslation}
 */
function buildFixedBlockTranslation(
  blockId,
  ko,
  textRole,
  layoutIntent,
  fontIntent,
  visualClusterId,
) {
  return {
    blockId,
    ...(textRole ? { textRole } : {}),
    ...(layoutIntent ? { layoutIntent } : {}),
    ...(fontIntent ?? {}),
    ...(visualClusterId ? { visualClusterId } : {}),
    ko,
  };
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
