// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {RuntimeOptions & { imageWidth?: unknown; imageHeight?: unknown; sourceLanguage?: unknown }} OcrBboxOptions */
/** @typedef {{ noTextDetected?: boolean; textEvidenceCount?: number }} OcrBboxResultOptions */
/** @typedef {{ hints: unknown[]; diagnostics: unknown[]; noTextDetected: boolean; textEvidenceCount: number }} OcrBboxResult */

/**
 * @param {{
 *   normalizeOcrBboxHintPayload: (payload: unknown, options?: OcrBboxOptions) => unknown[];
 *   readOcrCandidateText: (hint: unknown) => string;
 *   summarizeOcrErrorMessage: (error: unknown) => string;
 * }} dependencies
 */
function createOcrBboxResults(dependencies) {
  /**
   * @param {unknown[]} [hints]
   * @param {unknown[]} [diagnostics]
   * @param {OcrBboxResultOptions} [options]
   * @returns {OcrBboxResult}
   */
  function buildOcrBboxResult(hints = [], diagnostics = [], options = {}) {
    const normalizedHints = Array.isArray(hints) ? hints : [];
    return {
      hints: normalizedHints,
      diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
      noTextDetected: resolveNoTextDetected(normalizedHints, options),
      textEvidenceCount: resolveTextEvidenceCount(normalizedHints, options),
    };
  }

  /** @param {unknown[]} hints @param {OcrBboxResultOptions} options */
  function resolveNoTextDetected(hints, options) {
    return typeof options.noTextDetected === "boolean"
      ? options.noTextDetected
      : hints.length === 0;
  }

  /** @param {unknown[]} hints @param {OcrBboxResultOptions} options */
  function resolveTextEvidenceCount(hints, options) {
    const configured = Number(options.textEvidenceCount);
    return Number.isFinite(configured) && configured >= 0
      ? configured
      : countOcrTextEvidence(hints);
  }

  /** @param {unknown} value @param {OcrBboxOptions} [options] */
  function normalizeOcrBboxResultPayload(value, options = {}) {
    const record = asResultRecord(value);
    const textEvidenceCount = readNonNegativeNumber(record.textEvidenceCount);
    return {
      hints: dependencies.normalizeOcrBboxHintPayload(record.hints, options),
      diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics : [],
      noTextDetected:
        typeof record.noTextDetected === "boolean"
          ? record.noTextDetected
          : undefined,
      textEvidenceCount,
    };
  }

  /** @param {unknown[]} [hints] */
  function countOcrTextEvidence(hints = []) {
    return hints.filter((hint) =>
      hasJapaneseTextEvidence(dependencies.readOcrCandidateText(hint)),
    ).length;
  }

  /**
   * @param {string} provider
   * @param {unknown} error
   * @param {Record<string, unknown>} [extra]
   */
  function buildOcrBboxDiagnostic(provider, error, extra = {}) {
    return {
      provider,
      reason: "ocr-bbox-unavailable",
      message: dependencies.summarizeOcrErrorMessage(error),
      ...extra,
    };
  }

  return {
    buildOcrBboxDiagnostic,
    buildOcrBboxResult,
    normalizeOcrBboxResultPayload,
  };
}

/** @param {unknown} value */
function hasJapaneseTextEvidence(value) {
  return /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u30fc]/u.test(
    String(value ?? ""),
  );
}

/** @param {unknown} value */
function readNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** @param {unknown} value */
function asResultRecord(value) {
  return value && typeof value === "object"
    ? /** @type {{ hints?: unknown; diagnostics?: unknown; noTextDetected?: unknown; textEvidenceCount?: unknown }} */ (
        value
      )
    : {};
}

module.exports = { createOcrBboxResults };
