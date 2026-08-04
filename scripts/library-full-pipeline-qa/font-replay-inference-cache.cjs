"use strict";

const path = require("node:path");

const CACHE_VALIDATION_VERSION = 2;
const GLYPH_MORPHOLOGY_CONTRACT_VERSION = "font-matching-glyph-morphology-v1";
const USER_PAGE_BOUNDARY = Object.freeze({
  source: "user_page",
  datasetSplit: null,
  qaOverlay: false,
});

class FontReplayInferenceCacheError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "FontReplayInferenceCacheError";
    this.code = code;
  }
}

/**
 * @param {string} cacheFrom
 * @param {any} record
 * @param {any} cached
 * @returns {string}
 */
function resolveFontReplayInferencePath(cacheFrom, record, cached) {
  if (cached?.selectionIndex !== record?.selectionIndex) {
    fail(
      "selection_index_mismatch",
      "Cached inference selection index drifted.",
    );
  }
  const deterministic = path.join(
    cacheFrom,
    "pages",
    String(record.selectionIndex + 1).padStart(2, "0"),
    "font-inference.json",
  );
  if (
    typeof cached.fontInferencePath !== "string" ||
    !cached.fontInferencePath
  ) {
    return deterministic;
  }
  const explicit = path.resolve(cached.fontInferencePath);
  if (!isWithin(cacheFrom, explicit)) {
    fail(
      "inference_path_outside_cache_run",
      "Cached inference path escapes the source run.",
    );
  }
  return explicit;
}

/**
 * Restore only raw verified pixel inference. Page/chapter font policy is always
 * rerun by the current application code after this boundary.
 *
 * @param {{
 *   cachedPage: any,
 *   currentRuntime: { status: any, rendererHash: string, retiredFontIds: readonly string[] },
 *   fontInput: any,
 *   record: any,
 *   trace: any,
 * }} options
 */
function restoreCachedFontInference(options) {
  validateSourcePage(options.record, options.cachedPage, options.fontInput);
  validateRuntime(options.trace?.runtimeArtifactStatus, options.currentRuntime);
  const requestBlocks = validateRequestBlocks(
    options.trace?.requestBlocks,
    options.fontInput?.requestBlocks,
  );
  const inferences = validateInferences(
    options.trace?.pixelInference,
    requestBlocks,
    options.record.page.id,
    options.currentRuntime,
  );
  return {
    runtimeArtifactStatus: options.currentRuntime.status,
    pixelInferenceByBlockId: new Map(
      inferences.map((inference) => [inference.blockId, inference]),
    ),
  };
}

/** @param {any} record @param {any} cachedPage @param {any} fontInput */
function validateSourcePage(record, cachedPage, fontInput) {
  if (
    cachedPage?.status !== "completed" ||
    cachedPage.sourcePageId !== record?.page?.id ||
    cachedPage.sourcePageSha256 !== record?.page?.imageSha256 ||
    fontInput?.sourcePageId !== record?.page?.id ||
    fontInput?.sourcePageSha256 !== record?.page?.imageSha256
  ) {
    fail("source_page_mismatch", "Cached inference source page drifted.");
  }
}

/** @param {any} cachedStatus @param {any} currentRuntime */
function validateRuntime(cachedStatus, currentRuntime) {
  const currentStatus = currentRuntime?.status;
  if (currentStatus?.state !== "ready" || cachedStatus?.state !== "ready") {
    fail("runtime_not_ready", "Font inference runtime is not ready.");
  }
  if (stableJson(cachedStatus) !== stableJson(currentStatus)) {
    fail("runtime_artifact_mismatch", "Runtime artifact identity drifted.");
  }
  if (!sha256(currentRuntime.rendererHash)) {
    fail("renderer_identity_invalid", "Current renderer identity is invalid.");
  }
}

/**
 * @param {any} cachedBlocks
 * @param {any} currentBlocks
 * @returns {any[]}
 */
function validateRequestBlocks(cachedBlocks, currentBlocks) {
  if (!Array.isArray(cachedBlocks) || !Array.isArray(currentBlocks)) {
    fail(
      "request_blocks_missing",
      "Cached inference request blocks are missing.",
    );
  }
  if (stableJson(cachedBlocks) !== stableJson(currentBlocks)) {
    fail("request_blocks_mismatch", "Cached inference request blocks drifted.");
  }
  const ids = currentBlocks.map((entry) => entry?.blockId);
  if (
    ids.some((id) => typeof id !== "string" || !id) ||
    new Set(ids).size !== ids.length
  ) {
    fail(
      "request_block_ids_invalid",
      "Inference request block IDs are invalid.",
    );
  }
  return currentBlocks;
}

/**
 * @param {any} cachedInferences
 * @param {any[]} requestBlocks
 * @param {any} pageId
 * @param {any} currentRuntime
 * @returns {any[]}
 */
function validateInferences(
  cachedInferences,
  requestBlocks,
  pageId,
  currentRuntime,
) {
  if (!Array.isArray(cachedInferences)) {
    fail("pixel_inference_missing", "Cached pixel inference is missing.");
  }
  const requestIds = new Set(requestBlocks.map((entry) => entry.blockId));
  const seen = new Set();
  for (const inference of cachedInferences) {
    validateInferenceIdentity(inference, pageId, currentRuntime);
    if (!requestIds.has(inference.blockId) || seen.has(inference.blockId)) {
      fail("pixel_block_ids_mismatch", "Cached pixel block IDs drifted.");
    }
    seen.add(inference.blockId);
    validateRankedCandidates(inference, currentRuntime);
    validateGlyphMorphology(inference);
  }
  return cachedInferences;
}

/** @param {any} inference */
function validateGlyphMorphology(inference) {
  const morphology = inference?.glyphMorphology;
  // Version 1 caches predate this optional audit field. Page policy treats a
  // missing value as a failed Dohyeon gate, so replay remains fail-closed.
  if (morphology === undefined) return;
  const validators = [
    hasExpectedGlyphMorphologyIdentity,
    hasValidGlyphMorphologyDimensions,
    hasValidGlyphMorphologyMeasurements,
  ];
  if (!validators.every((validate) => validate(morphology))) {
    fail(
      "glyph_morphology_contract_mismatch",
      "Cached glyph morphology audit drifted.",
    );
  }
}

/** @param {any} morphology @returns {boolean} */
function hasExpectedGlyphMorphologyIdentity(morphology) {
  return [
    morphology.contractVersion === GLYPH_MORPHOLOGY_CONTRACT_VERSION,
    morphology.maskSource === "raw_grayscale_otsu_minority_area3",
    morphology.distanceTransform === "opencv_dist_l2_mask5",
    morphology.connectivity === 8,
  ].every(Boolean);
}

/** @param {any} morphology @returns {boolean} */
function hasValidGlyphMorphologyDimensions(morphology) {
  const nonnegativeIntegers = [
    morphology.maskWidth,
    morphology.maskHeight,
    morphology.foregroundPixelCount,
    morphology.connectedComponentCount,
  ].every(isNonnegativeInteger);
  return [
    nonnegativeIntegers,
    morphology.maskWidth > 0,
    morphology.maskHeight > 0,
    Number.isInteger(morphology.otsuThreshold),
    morphology.otsuThreshold >= 0,
    morphology.otsuThreshold <= 255,
    ["dark", "light"].includes(morphology.foregroundPolarity),
  ].every(Boolean);
}

/** @param {any} morphology @returns {boolean} */
function hasValidGlyphMorphologyMeasurements(morphology) {
  const nonnegative = [
    morphology.globalForegroundDistanceMean,
    morphology.medianComponentDistanceMean,
  ];
  const luma = [morphology.foregroundMeanLuma, morphology.backgroundMeanLuma];
  const measurements = [
    ...nonnegative,
    morphology.medianComponentFill,
    ...luma,
  ];
  return [
    measurements.every(Number.isFinite),
    nonnegative.every((value) => value >= 0),
    morphology.medianComponentFill >= 0,
    morphology.medianComponentFill <= 1,
    luma.every((value) => value >= 0 && value <= 255),
  ].every(Boolean);
}

/** @param {any} value @returns {boolean} */
function isNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** @param {any} inference @param {any} pageId @param {any} currentRuntime */
function validateInferenceIdentity(inference, pageId, currentRuntime) {
  const status = currentRuntime.status;
  const evidence = inference?.localEvidence;
  if (
    inference?.kind !== "verified_pixel_inference" ||
    inference.pageId !== pageId ||
    typeof inference.blockId !== "string" ||
    !inference.blockId ||
    inference.modelVersion !== status.modelVersion ||
    inference.candidateOrderSha256 !== status.candidateOrderSha256 ||
    stableJson(inference.inputBoundary) !== stableJson(USER_PAGE_BOUNDARY) ||
    evidence?.catalogVersion !== status.catalogVersion ||
    evidence?.modelVersion !== status.modelVersion ||
    evidence?.rendererHash !== currentRuntime.rendererHash
  ) {
    fail(
      "pixel_inference_identity_mismatch",
      "Pixel inference identity drifted.",
    );
  }
}

/** @param {any} inference @param {any} currentRuntime */
function validateRankedCandidates(inference, currentRuntime) {
  const ranked = inference.localEvidence?.rankedCandidates;
  /** @type {any[]} */
  const candidateIds = currentRuntime.status.candidateIds;
  if (!Array.isArray(ranked) || ranked.length !== candidateIds.length) {
    fail("candidate_inventory_mismatch", "Cached candidate inventory drifted.");
  }
  const actualIds = ranked.map((candidate) => candidate?.fontId);
  if (
    new Set(actualIds).size !== actualIds.length ||
    candidateIds.some((candidateId) => !actualIds.includes(candidateId)) ||
    ranked.some((candidate, index) => candidate?.rank !== index + 1)
  ) {
    fail("candidate_inventory_mismatch", "Cached candidate inventory drifted.");
  }
  for (const retiredId of currentRuntime.retiredFontIds) {
    // A retired face can either remain in a compatibility inventory as an
    // explicit unrenderable sentinel, or be removed from the active catalog
    // entirely. Runtime identity validation above already seals the latter
    // inventory, so absence is the expected safe state for active21/no-Gugi.
    if (!candidateIds.includes(retiredId)) continue;
    const retired = ranked.find((candidate) => candidate.fontId === retiredId);
    if (
      !retired ||
      retired.renderStatus !== "unrenderable" ||
      retired.unrenderableReason !== "font_retired_by_product_policy" ||
      retired.confidence !== 0 ||
      !retired.reasonCodes?.includes("font_retired_by_product_policy")
    ) {
      fail(
        "retired_font_policy_mismatch",
        "Cached inference predates the current retired-font policy.",
      );
    }
  }
}

/** @param {string} root @param {string} target @returns {boolean} */
function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/** @param {any} value @returns {string} */
function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

/** @param {any} value @returns {any} */
function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

/** @param {unknown} value @returns {boolean} */
function sha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

/** @param {string} code @param {string} message @returns {never} */
function fail(code, message) {
  throw new FontReplayInferenceCacheError(code, message);
}

module.exports = {
  CACHE_VALIDATION_VERSION,
  FontReplayInferenceCacheError,
  resolveFontReplayInferencePath,
  restoreCachedFontInference,
};
