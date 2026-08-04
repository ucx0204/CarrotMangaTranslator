"use strict";

const path = require("node:path");

/**
 * @param {string} cacheFrom
 * @param {any} record
 * @param {any} cached
 * @returns {string}
 */
function resolveFontReplayInputPath(cacheFrom, record, cached) {
  if (cached?.selectionIndex !== record?.selectionIndex) {
    throw new Error(
      "Cached run page selection index does not match the cohort.",
    );
  }
  if (typeof cached.fontInputPath === "string" && cached.fontInputPath) {
    return cached.fontInputPath;
  }
  return path.join(
    cacheFrom,
    "pages",
    String(record.selectionIndex + 1).padStart(2, "0"),
    "font-input.json",
  );
}

/**
 * Resolve the raster used by a cached font-only replay.
 *
 * A page with no translated/request blocks never needed inpainting, so its
 * frozen source image is already the correct clean raster. Any non-empty
 * page still requires the cached inpainting result and must fail closed when
 * that asset is absent.
 *
 * @param {any} record
 * @param {any} cached
 * @param {any} fontInput
 * @returns {string}
 */
function resolveFontReplayImagePath(record, cached, fontInput) {
  if (typeof cached?.cleanedImagePath === "string" && cached.cleanedImagePath) {
    return cached.cleanedImagePath;
  }
  const pageBlocks = fontInput?.page?.blocks;
  const requestBlocks = fontInput?.requestBlocks;
  if (
    Array.isArray(pageBlocks) &&
    pageBlocks.length === 0 &&
    Array.isArray(requestBlocks) &&
    requestBlocks.length === 0 &&
    typeof record?.page?.imagePath === "string" &&
    record.page.imagePath
  ) {
    return record.page.imagePath;
  }
  throw new Error("Cached run has no reusable translation/inpainting assets.");
}

/**
 * Recreate the production page-local font decision context for a cached replay.
 * The positional array must follow requestBlocks, not Map insertion order,
 * because both the decision loop and page-priority ordering address it by item
 * index.
 *
 * @param {{
 *   automaticFontCoordinator: {
 *     createAutomaticFontPageCoordinatorV2: (options: any) => any,
 *     orderAutomaticFontMatchingPageItemIndexes: (items: any[], pixelInferences: any[]) => number[],
 *   },
 *   chapterCoordinator: any,
 *   inferred: { pixelInferenceByBlockId: Map<string, any> },
 *   requestBlocks: Array<{ blockId: string, item: any }>,
 * }} options
 */
function createFontReplayPageDecisionContext(options) {
  const items = options.requestBlocks.map((entry) => entry.item);
  const pixelInferences = options.requestBlocks.map((entry) =>
    options.inferred.pixelInferenceByBlockId.get(entry.blockId),
  );
  const pageCoordinator =
    options.automaticFontCoordinator.createAutomaticFontPageCoordinatorV2({
      chapterCoordinator: options.chapterCoordinator,
      items,
      pixelInferences,
    });
  const orderedItemIndexes =
    options.automaticFontCoordinator.orderAutomaticFontMatchingPageItemIndexes(
      items,
      pixelInferences,
    );
  return { orderedItemIndexes, pageCoordinator, pixelInferences };
}

/**
 * Restore translation-time semantic metadata only after the pixel-only font
 * decision has been applied. This keeps the renderer's layout role distinct
 * from automaticFontMatch.role, which records the role used by font selection.
 *
 * @param {any} block
 * @param {any} item
 * @returns {any}
 */
function restoreFontReplaySemanticRole(block, item) {
  if (typeof item?.fontRole !== "string" || !item.fontRole) return block;
  const restored = { ...block, fontRole: item.fontRole };
  if (
    typeof item.fontRoleConfidence === "number" &&
    Number.isFinite(item.fontRoleConfidence)
  ) {
    restored.fontRoleConfidence = item.fontRoleConfidence;
  } else {
    delete restored.fontRoleConfidence;
  }
  return restored;
}

module.exports = {
  createFontReplayPageDecisionContext,
  resolveFontReplayImagePath,
  resolveFontReplayInputPath,
  restoreFontReplaySemanticRole,
};
