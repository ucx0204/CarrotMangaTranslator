// @ts-check

const {
  mergeFixedBlockTranslationResults,
} = require("./fixed-block-response.cjs");

/**
 * @typedef {{blockId:string;ko:string;textRole?:"ordinary"|"sound";layoutIntent?:"horizontal"|"vertical";fontRole?:string;fontRoleConfidence?:number;visualClusterId?:string}} FixedBlockTranslation
 * @typedef {{items:FixedBlockTranslation[];pageContext?:Record<string,unknown>}} FixedBlockTranslationResult
 */

/**
 * Recover only exhausted presentation-metadata conflicts or target-side
 * punctuation that already carried an otherwise-valid translation. Every
 * other pending id remains unresolved for the transport's fail-closed check.
 *
 * @param {{translations:FixedBlockTranslationResult;pendingBlockIds:string[];responses:unknown[];history:unknown[];retryReasons:Record<string,string[]>}} repaired
 * @param {{horizontal:Map<string,FixedBlockTranslation>;fontIntent:Map<string,FixedBlockTranslation>;targetTypography:Map<string,FixedBlockTranslation>}} fallbacks
 * @param {string[]} expectedIds
 */
function completeFixedBlockFallbacks(repaired, fallbacks, expectedIds) {
  const selectedFallbacks = repaired.pendingBlockIds.flatMap((blockId) => {
    const targetTypography = fallbacks.targetTypography.get(blockId);
    if (targetTypography) {
      return [{ blockId, kind: "targetTypography", item: targetTypography }];
    }
    const fontIntent = fallbacks.fontIntent.get(blockId);
    if (fontIntent) {
      return [{ blockId, kind: "fontIntent", item: fontIntent }];
    }
    const horizontal = fallbacks.horizontal.get(blockId);
    return horizontal
      ? [{ blockId, kind: "horizontal", item: horizontal }]
      : [];
  });
  const horizontalFallbackBlockIds = selectedFallbacks
    .filter(({ kind }) => kind === "horizontal")
    .map(({ blockId }) => blockId);
  const fontIntentFallbackBlockIds = selectedFallbacks
    .filter(({ kind }) => kind === "fontIntent")
    .map(({ blockId }) => blockId);
  const targetTypographyFallbackBlockIds = selectedFallbacks
    .filter(({ kind }) => kind === "targetTypography")
    .map(({ blockId }) => blockId);
  if (selectedFallbacks.length === 0) {
    return {
      ...repaired,
      horizontalFallbackBlockIds,
      fontIntentFallbackBlockIds,
      targetTypographyFallbackBlockIds,
    };
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
    horizontalFallbackBlockIds,
    fontIntentFallbackBlockIds,
    targetTypographyFallbackBlockIds,
  };
}

module.exports = { completeFixedBlockFallbacks };
