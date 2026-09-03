// @ts-check

const {
  mergeFixedBlockTranslationResults,
} = require("./fixed-block-response.cjs");

/**
 * @typedef {{blockId:string;ko:string;textRole?:"ordinary"|"sound";layoutIntent?:"horizontal"|"vertical";fontRole?:string;fontRoleConfidence?:number;visualClusterId?:string}} FixedBlockTranslation
 * @typedef {{items:FixedBlockTranslation[];pageContext?:Record<string,unknown>}} FixedBlockTranslationResult
 * @typedef {{blockId:string;jp:string}} FixedBlockSource
 * @typedef {"horizontal"|"fontIntent"|"targetTypography"|"sourceScript"|"readableText"|"sourceText"} FixedBlockFallbackKind
 * @typedef {{blockId:string;kind:FixedBlockFallbackKind;item:FixedBlockTranslation}} SelectedFixedBlockFallback
 */

/**
 * Prefer a repaired or safely normalized translation, then retain the last
 * readable model text, and finally preserve the immutable OCR source. A
 * block-local model failure must not discard the rest of the translated page.
 *
 * @param {{translations:FixedBlockTranslationResult;pendingBlockIds:string[];responses:unknown[];history:unknown[];retryReasons:Record<string,string[]>}} repaired
 * @param {{horizontal:Map<string,FixedBlockTranslation>;fontIntent:Map<string,FixedBlockTranslation>;targetTypography:Map<string,FixedBlockTranslation>;sourceScript:Map<string,FixedBlockTranslation>;readableText:Map<string,FixedBlockTranslation>}} fallbacks
 * @param {FixedBlockSource[]} blocks
 */
function completeFixedBlockFallbacks(repaired, fallbacks, blocks) {
  const expectedIds = blocks.map((block) => block.blockId);
  const sourceById = new Map(blocks.map((block) => [block.blockId, block.jp]));
  const selectedFallbacks = selectFixedBlockFallbacks(
    repaired.pendingBlockIds,
    fallbacks,
    sourceById,
  );
  const summary = summarizeSelectedFallbacks(selectedFallbacks);
  if (selectedFallbacks.length === 0) {
    return { ...repaired, ...summary };
  }
  const recoveredIds = new Set(selectedFallbacks.map(({ blockId }) => blockId));
  return {
    ...repaired,
    translations: mergeFixedBlockTranslationResults(
      repaired.translations,
      { items: selectedFallbacks.map(({ item }) => item) },
      expectedIds,
    ),
    pendingBlockIds: repaired.pendingBlockIds.filter(
      (blockId) => !recoveredIds.has(blockId),
    ),
    ...summary,
  };
}

/**
 * @param {string[]} pendingBlockIds
 * @param {{horizontal:Map<string,FixedBlockTranslation>;fontIntent:Map<string,FixedBlockTranslation>;targetTypography:Map<string,FixedBlockTranslation>;sourceScript:Map<string,FixedBlockTranslation>;readableText:Map<string,FixedBlockTranslation>}} fallbacks
 * @param {Map<string,string>} sourceById
 * @returns {SelectedFixedBlockFallback[]}
 */
function selectFixedBlockFallbacks(pendingBlockIds, fallbacks, sourceById) {
  return pendingBlockIds.map((blockId) =>
    selectFixedBlockFallback(blockId, fallbacks, sourceById),
  );
}

/**
 * @param {string} blockId
 * @param {{horizontal:Map<string,FixedBlockTranslation>;fontIntent:Map<string,FixedBlockTranslation>;targetTypography:Map<string,FixedBlockTranslation>;sourceScript:Map<string,FixedBlockTranslation>;readableText:Map<string,FixedBlockTranslation>}} fallbacks
 * @param {Map<string,string>} sourceById
 * @returns {SelectedFixedBlockFallback}
 */
function selectFixedBlockFallback(blockId, fallbacks, sourceById) {
  const storedKinds = /** @type {const} */ ([
    "targetTypography",
    "fontIntent",
    "horizontal",
    "sourceScript",
    "readableText",
  ]);
  for (const kind of storedKinds) {
    const item = fallbacks[kind].get(blockId);
    if (item) return { blockId, kind, item };
  }
  const sourceText = String(sourceById.get(blockId) ?? "").trim();
  return {
    blockId,
    kind: "sourceText",
    item: { blockId, ko: sourceText || "…" },
  };
}

/** @param {SelectedFixedBlockFallback[]} selected */
function summarizeSelectedFallbacks(selected) {
  /** @param {FixedBlockFallbackKind} kind */
  const ids = (kind) =>
    selected
      .filter((fallback) => fallback.kind === kind)
      .map(({ blockId }) => blockId);
  const sourceScriptFallbackBlockIds = ids("sourceScript");
  const readableTextFallbackBlockIds = ids("readableText");
  const sourceTextFallbackBlockIds = ids("sourceText");
  return {
    horizontalFallbackBlockIds: ids("horizontal"),
    fontIntentFallbackBlockIds: ids("fontIntent"),
    targetTypographyFallbackBlockIds: ids("targetTypography"),
    sourceScriptFallbackBlockIds,
    readableTextFallbackBlockIds,
    sourceTextFallbackBlockIds,
    needsReviewBlockIds: [
      ...sourceScriptFallbackBlockIds,
      ...readableTextFallbackBlockIds,
      ...sourceTextFallbackBlockIds,
    ],
  };
}

module.exports = { completeFixedBlockFallbacks };
