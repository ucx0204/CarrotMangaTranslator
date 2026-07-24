// @ts-check

const { prepareImageVariants } = require("../simple-page-image-variants.cjs");
const {
  GROUP_REVIEW_CROP_PLAN_VERSION,
  buildGroupReviewCropImageVariants,
  buildGroupReviewCropPlan,
} = require("../semantic-ocr/group-review-crops.cjs");
const {
  GROUP_ONLY_PROMPT_CONTRACT_VERSION,
  GROUP_ONLY_REVIEW_VERSION,
  applyReviewedGroupsToHints,
  buildGroupOnlyReviewFallback,
  buildGroupOnlyReviewPlan,
  reviewGroupOnlyCrop,
} = require("../semantic-ocr/group-only-review.cjs");
const {
  classifyGroupOnlyReviewRequestFailure,
} = require("../semantic-ocr/review-errors.cjs");
const {
  buildPageReviewFingerprint,
  clearGroupOnlyPageReviewCache,
  deleteCachedPageReview,
  getOrCreateCachedPageReview,
} = require("./group-only-review-cache.cjs");
const {
  requestGroupOnlyCropCompletion,
} = require("./group-only-review-completion.cjs");
const { findAbortError } = require("./model-http-errors.cjs");
const { nowMs } = require("./model-runtime-services.cjs");

const GROUP_ONLY_REVIEW_REQUEST_VERSION = 1;

/**
 * @typedef {Record<string,unknown>} JsonRecord
 * @typedef {{baseUrl:string;[key:string]:unknown}} ModelServer
 * @typedef {{abortSignal?:AbortSignal|null;imagePath?:unknown;outputDir?:unknown;imageWidth?:unknown;imageHeight?:unknown;ocrBboxHints:JsonRecord[];[key:string]:unknown}} ReviewOptions
 * @typedef {{hints:unknown[];diagnostics?:unknown[];[key:string]:unknown}} OcrBboxResult
 * @typedef {{role:string;path:string;dataUrl?:string;width?:unknown;height?:unknown;semanticReviewCropId?:unknown;[key:string]:unknown}} ImageVariant
 * @typedef {{status:string;reviewedHints:JsonRecord[];summary:JsonRecord;rawResponse:JsonRecord;validated:boolean}} PageReviewData
 */

/**
 * Cache only the immutable page/model/hint review. AbortSignal and translation
 * attempt stay request-local when the cached result is materialized.
 * @param {ModelServer} server
 * @param {ReviewOptions} options
 * @param {OcrBboxResult} ocr
 */
async function requestGroupOnlyPageReview(server, options, ocr) {
  const cached = getOrCreateCachedPageReview(server, options, () =>
    runPageReview(server, options, ocr),
  );
  try {
    return materializeOutcome(options, await cached.promise, cached.cacheHit);
  } catch (error) {
    if (isAbort(error, options.abortSignal)) {
      deleteCachedPageReview(cached.key);
    }
    throw error;
  }
}

/**
 * @param {ModelServer} server
 * @param {ReviewOptions} options
 * @param {OcrBboxResult} _ocr
 * @returns {Promise<PageReviewData>}
 */
async function runPageReview(server, options, _ocr) {
  const startedAt = nowMs();
  return runPreparedPageReview(server, options, startedAt);
}

/**
 * @param {ModelServer} server
 * @param {ReviewOptions} options
 * @param {number} startedAt
 */
async function runPreparedPageReview(server, options, startedAt) {
  const prepared = await prepareImageVariants(
    /** @type {Parameters<typeof prepareImageVariants>[0]} */ (
      /** @type {unknown} */ (options)
    ),
  );
  const source = readReviewSource(
    /** @type {ImageVariant[]} */ (prepared.imageVariants),
    options,
  );
  if (!source) {
    return upstreamFallback(
      options.ocrBboxHints,
      startedAt,
      "original-image-unavailable",
      null,
      prepared.diagnostics,
    );
  }
  const plan = buildGroupReviewCropPlan(
    /** @type {Parameters<typeof buildGroupReviewCropPlan>[0]} */ (
      /** @type {unknown} */ (options.ocrBboxHints)
    ),
    source.width,
    source.height,
  );
  const preparedCrops = buildGroupReviewCropImageVariants(
    { imagePath: source.original.path },
    plan,
  );
  if (preparedCrops.fallbackReason || preparedCrops.crops.length === 0) {
    return upstreamFallback(
      options.ocrBboxHints,
      startedAt,
      preparedCrops.fallbackReason || "review-crops-empty",
      null,
      prepared.diagnostics,
      plan,
    );
  }
  const hintById = indexHints(options.ocrBboxHints);
  /** @type {Awaited<ReturnType<typeof reviewGroupOnlyCrop>>[]} */
  const results = [];
  const diagnostics = [];
  for (const crop of preparedCrops.crops) {
    throwIfAborted(options.abortSignal);
    const reviewCase = buildReviewCase(crop.region, hintById);
    const result = await reviewGroupOnlyCrop(
      reviewCase,
      crop.region,
      (payload) =>
        requestGroupOnlyCropCompletion(
          server,
          options,
          payload,
          crop.variant,
          GROUP_ONLY_REVIEW_REQUEST_VERSION,
        ).catch((error) => {
          throw classifyGroupOnlyReviewRequestFailure(error);
        }),
    );
    results.push(result);
    diagnostics.push(summarizeCrop(crop.region, result));
  }
  return finalizeReviewedPage(
    options.ocrBboxHints,
    plan,
    results,
    diagnostics,
    prepared.diagnostics,
    startedAt,
  );
}

/** @param {ImageVariant[]} variants @param {ReviewOptions} options */
function readReviewSource(variants, options) {
  const original = selectOriginal(variants);
  if (!original) return null;
  const width = positiveInteger(original.width ?? options.imageWidth);
  const height = positiveInteger(original.height ?? options.imageHeight);
  return width && height ? { original, width, height } : null;
}

/** @param {JsonRecord} region @param {Map<number,JsonRecord>} hintById */
function buildReviewCase(region, hintById) {
  /** @type {JsonRecord[]} */
  const candidates = (
    Array.isArray(region.candidates) ? region.candidates : []
  ).map((raw) => {
    const projected = asRecord(raw);
    const id = positiveInteger(projected.candidateId);
    const hint = id ? hintById.get(id) : null;
    if (!hint)
      throw new Error(`Unknown crop candidate ${projected.candidateId}.`);
    return {
      ...hint,
      bbox1000: projected.bbox1000,
      paddleGroupId: projected.paddleGroupId,
      paddleOrder: projected.paddleOrder,
      paddleGroupSize: projected.paddleGroupSize,
    };
  });
  return {
    candidates,
    candidateOrder: candidates.map((hint) => hint.id),
    upstreamFragments: (Array.isArray(region.fragments)
      ? region.fragments
      : []
    ).map((raw) => {
      const fragment = asRecord(raw);
      return {
        fragment: fragment.reviewFragmentId,
        status: fragment.reviewStatus,
        candidateIds: fragment.candidateIds,
      };
    }),
  };
}

/**
 * @param {JsonRecord[]} hints @param {ReturnType<typeof buildGroupReviewCropPlan>} plan
 * @param {Awaited<ReturnType<typeof reviewGroupOnlyCrop>>[]} results @param {JsonRecord[]} crops
 * @param {unknown} imageDiagnostics @param {number} startedAt
 * @returns {PageReviewData}
 */
function finalizeReviewedPage(
  hints,
  plan,
  results,
  crops,
  imageDiagnostics,
  startedAt,
) {
  const applied = applyReviewedGroupsToHints(hints, results, {
    // Exact upstream fallback is also safe for immutable translation.
    validatedGroupOnlyReview: true,
  });
  const fallbackCount = results.filter((item) => item.usedFallback).length;
  const requestCount = results.filter((item) => !item.requestSkipped).length;
  const status =
    fallbackCount === 0
      ? requestCount === 0
        ? "singleton-only"
        : "reviewed"
      : fallbackCount === results.length
        ? "upstream-fallback"
        : "partial-fallback";
  return pageData(
    status,
    applied.hints,
    applied.reviewedGroupCount,
    startedAt,
    {
      semanticGroupReviewRegionCount: plan.regions.length,
      semanticGroupReviewCandidateCount: plan.candidateCount,
      semanticGroupReviewFragmentCount: plan.fragmentCount,
      semanticGroupReviewRequestCount: requestCount,
      semanticGroupReviewSingletonSkipCount: results.length - requestCount,
      semanticGroupReviewFallbackCount: fallbackCount,
      ...diagnosticSummary(imageDiagnostics),
    },
    { status, crops },
  );
}

/**
 * @param {JsonRecord[]} hints @param {number} startedAt @param {string} reason
 * @param {unknown} error @param {unknown} diagnostics @param {JsonRecord|null} [plan]
 * @returns {PageReviewData}
 */
function upstreamFallback(
  hints,
  startedAt,
  reason,
  error,
  diagnostics,
  plan = null,
) {
  const candidateOrder = hints.map((hint) => Number(hint.id));
  const fallback = buildGroupOnlyReviewFallback(
    buildGroupOnlyReviewPlan({
      candidates: hints,
      candidateOrder,
      upstreamFragments: upstreamFragments(hints),
    }),
  );
  const applied = applyReviewedGroupsToHints(hints, [fallback], {
    validatedGroupOnlyReview: true,
  });
  return pageData(
    "upstream-fallback",
    applied.hints,
    applied.reviewedGroupCount,
    startedAt,
    {
      semanticGroupReviewRegionCount: Array.isArray(plan?.regions)
        ? plan.regions.length
        : 0,
      semanticGroupReviewCandidateCount: hints.length,
      semanticGroupReviewRequestCount: 0,
      semanticGroupReviewSingletonSkipCount: 0,
      semanticGroupReviewFallbackCount: 1,
      semanticGroupReviewFallbackReason: reason,
      ...(error
        ? { semanticGroupReviewFallbackError: describeError(error) }
        : {}),
      ...diagnosticSummary(diagnostics),
    },
    {
      status: "upstream-fallback",
      reason,
      error: error ? describeError(error) : null,
      crops: [],
    },
  );
}

/**
 * @param {string} status @param {JsonRecord[]} hints @param {number} groupCount
 * @param {number} startedAt @param {JsonRecord} details @param {JsonRecord} rawResponse
 * @returns {PageReviewData}
 */
function pageData(status, hints, groupCount, startedAt, details, rawResponse) {
  return {
    status,
    reviewedHints: hints,
    validated: true,
    summary: {
      semanticGroupReviewRequestVersion: GROUP_ONLY_REVIEW_REQUEST_VERSION,
      semanticGroupReviewContractVersion: GROUP_ONLY_REVIEW_VERSION,
      semanticGroupReviewPromptContractVersion:
        GROUP_ONLY_PROMPT_CONTRACT_VERSION,
      semanticGroupReviewCropPlanVersion: GROUP_REVIEW_CROP_PLAN_VERSION,
      semanticGroupReviewStatus: status,
      semanticGroupReviewFinalGroupCount: groupCount,
      semanticGroupReviewWallMs: Math.round(nowMs() - startedAt),
      ...details,
    },
    rawResponse,
  };
}

/** @param {JsonRecord[]} hints */
function upstreamFragments(hints) {
  /** @type {Map<string,Array<{id:number;order:number}>>} */
  const fragments = new Map();
  hints.forEach((hint, index) => {
    const key = String(hint.reviewFragmentId ?? "").trim();
    if (!key) throw new Error(`Hint ${hint.id} has no review fragment.`);
    const id = positiveInteger(hint.id);
    if (!id) throw new Error("Review hint ids must be positive integers.");
    const members = fragments.get(key) || [];
    members.push({
      id,
      order: positiveInteger(hint.reviewOrder) || index + 1,
    });
    fragments.set(key, members);
  });
  return [...fragments.entries()].map(([fragment, members]) => ({
    fragment,
    candidateIds: members
      .sort((left, right) => left.order - right.order)
      .map((member) => member.id),
  }));
}

/** @param {ReviewOptions} options @param {PageReviewData} data @param {boolean} cacheHit */
function materializeOutcome(options, data, cacheHit) {
  const hints = data.reviewedHints.map((hint) => ({ ...hint }));
  return {
    status: data.status,
    promptOptions: data.validated
      ? {
          ...options,
          ocrBboxHints: hints,
          validatedGroupOnlyReview: true,
          groupOnlyReviewVersion: GROUP_ONLY_REVIEW_VERSION,
        }
      : options,
    summary: { ...data.summary, semanticGroupReviewCacheHit: cacheHit },
    rawResponse: { ...data.rawResponse, cacheHit },
  };
}

/** @param {JsonRecord[]} hints */
function indexHints(hints) {
  const result = new Map();
  for (const hint of hints) {
    const id = positiveInteger(hint.id);
    if (!id || result.has(id))
      throw new Error("Review hint ids must be unique.");
    result.set(id, hint);
  }
  return result;
}

/** @param {ImageVariant[]} variants */
function selectOriginal(variants) {
  return (
    variants.find(
      (item) =>
        item.role === "original" &&
        typeof item.dataUrl === "string" &&
        item.dataUrl.length > 0,
    ) || null
  );
}

/** @param {JsonRecord} region @param {JsonRecord} result */
function summarizeCrop(region, result) {
  return {
    cropId: region.cropId,
    candidateIds: region.candidateIds,
    status: result.status,
    source: result.source,
    usedFallback: result.usedFallback === true,
    requestSkipped: result.requestSkipped === true,
    groupCandidateIds: Array.isArray(result.groups)
      ? result.groups.map((group) => group.candidateIds)
      : [],
    fallbackError: result.fallbackError ?? null,
    rawResponse: result.rawResponse ?? null,
  };
}

/** @param {unknown} diagnostics */
function diagnosticSummary(diagnostics) {
  return Array.isArray(diagnostics) && diagnostics.length > 0
    ? { semanticGroupReviewImageDiagnostics: diagnostics }
    : {};
}

/** @param {AbortSignal|null|undefined} signal */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

/** @param {unknown} error @param {AbortSignal|null|undefined} signal */
function isAbort(error, signal) {
  return Boolean(signal?.aborted || findAbortError(error));
}

/** @param {unknown} value */
function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** @param {unknown} value */
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return /** @type {JsonRecord} */ (value);
}

/** @param {unknown} error */
function describeError(error) {
  const record =
    error && typeof error === "object" ? /** @type {JsonRecord} */ (error) : {};
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
    ...(typeof record.code === "string" ? { code: record.code } : {}),
  };
}

module.exports = {
  GROUP_ONLY_REVIEW_REQUEST_VERSION,
  buildPageReviewFingerprint,
  clearGroupOnlyPageReviewCache,
  requestGroupOnlyPageReview,
};
