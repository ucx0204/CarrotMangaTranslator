// @ts-check

const {
  mergeFixedBlockTranslationResults,
} = require("./fixed-block-response.cjs");

/**
 * @typedef {{blockId:string;ko:string;textRole?:"ordinary"|"sound";layoutIntent?:"horizontal"|"vertical";fontRole?:string;fontRoleConfidence?:number;visualClusterId?:string}} FixedBlockTranslation
 * @typedef {{items:FixedBlockTranslation[];pageContext?:Record<string,unknown>}} FixedBlockTranslationResult
 */

/**
 * Apply a horizontal advisory only to still-pending blocks that have a saved
 * otherwise-valid translation. Every other pending id remains unresolved for
 * the transport's fail-closed completion check.
 *
 * @param {{translations:FixedBlockTranslationResult;pendingBlockIds:string[];responses:unknown[];history:unknown[]}} repaired
 * @param {Map<string,FixedBlockTranslation>} fallbackById
 * @param {string[]} expectedIds
 */
function completeHorizontalFixedBlockFallbacks(
  repaired,
  fallbackById,
  expectedIds,
) {
  const horizontalFallbackBlockIds = repaired.pendingBlockIds.filter(
    (blockId) => fallbackById.has(blockId),
  );
  if (horizontalFallbackBlockIds.length === 0) {
    return { ...repaired, horizontalFallbackBlockIds };
  }
  const fallbackItems = horizontalFallbackBlockIds.flatMap((blockId) => {
    const item = fallbackById.get(blockId);
    return item ? [item] : [];
  });
  const recoveredIds = new Set(horizontalFallbackBlockIds);
  return {
    ...repaired,
    translations: mergeFixedBlockTranslationResults(
      repaired.translations,
      { items: fallbackItems },
      expectedIds,
    ),
    pendingBlockIds: repaired.pendingBlockIds.filter(
      (blockId) => !recoveredIds.has(blockId),
    ),
    horizontalFallbackBlockIds,
  };
}

module.exports = { completeHorizontalFixedBlockFallbacks };
