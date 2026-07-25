// @ts-check

const { createHash } = require("node:crypto");
const { statSync } = require("node:fs");
const path = require("node:path");

const CACHE_LIMIT = 24;
const pageReviewCache = new Map();

/**
 * @typedef {Record<string,unknown>} JsonRecord
 * @typedef {{baseUrl:string;[key:string]:unknown}} ModelServer
 * @typedef {{imagePath?:unknown;imageWidth?:unknown;imageHeight?:unknown;ocrBboxHints:JsonRecord[];[key:string]:unknown}} ReviewOptions
 */

/**
 * @template TResult
 * @param {ModelServer} server
 * @param {ReviewOptions} options
 * @param {()=>Promise<TResult>} create
 */
function getOrCreateCachedPageReview(server, options, create) {
  const key = buildPageReviewFingerprint(server, options);
  let pending = pageReviewCache.get(key);
  const cacheHit = Boolean(pending);
  if (pending) {
    pageReviewCache.delete(key);
    pageReviewCache.set(key, pending);
  } else {
    pending = create();
    while (pageReviewCache.size >= CACHE_LIMIT) {
      const oldest = pageReviewCache.keys().next().value;
      if (typeof oldest !== "string") break;
      pageReviewCache.delete(oldest);
    }
    pageReviewCache.set(key, pending);
    evictRejectedPageReview(key, pending);
  }
  return {
    key,
    cacheHit,
    promise: /** @type {Promise<TResult>} */ (pending),
  };
}

/** @param {ModelServer} server @param {ReviewOptions} options */
function buildPageReviewFingerprint(server, options) {
  const hints = options.ocrBboxHints.map((hint) => [
    hint.id,
    hint.x1,
    hint.y1,
    hint.x2,
    hint.y2,
    hint.ocrText,
    hint.score,
    hint.reviewFragmentId,
    hint.reviewStatus,
    hint.reviewReasons,
    hint.reviewOrder,
    hint.reviewContextId,
    hint.animeTextRegionId,
    hint.animeTextRegionScore,
    hint.animeTextContainment,
    hint.animeTextRegionBbox,
    hint.animeTextEvidenceVersion,
    hint.animeTextModelRevision,
    hint.paddleGroupId,
    hint.paddleOrder,
    hint.paddleGroupSize,
  ]);
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 14,
        image: imageFingerprint(options.imagePath),
        size: [options.imageWidth, options.imageHeight],
        model: [
          options.modelRepo,
          options.modelFile,
          options.localModelPath,
          options.mmprojRepo,
          options.mmprojFile,
          options.localMmprojPath,
        ],
        vision: [options.imageMinTokens, options.imageMaxTokens],
        server: server.baseUrl,
        hints,
      }),
    )
    .digest("hex");
}

/** @param {unknown} value */
function imageFingerprint(value) {
  const filePath = path.resolve(String(value ?? ""));
  try {
    const stat = statSync(filePath);
    return [filePath, stat.size, Math.round(stat.mtimeMs)];
  } catch (_error) {
    return [filePath, null, null];
  }
}

/** @param {string} key @param {Promise<unknown>} pending */
function evictRejectedPageReview(key, pending) {
  void pending.catch(() => {
    deleteCachedPageReview(key, pending);
  });
}

/** @param {string} key @param {Promise<unknown>} expected */
function deleteCachedPageReview(key, expected) {
  if (pageReviewCache.get(key) !== expected) return false;
  return pageReviewCache.delete(key);
}

function clearGroupOnlyPageReviewCache() {
  pageReviewCache.clear();
}

module.exports = {
  buildPageReviewFingerprint,
  clearGroupOnlyPageReviewCache,
  deleteCachedPageReview,
  getOrCreateCachedPageReview,
};
