// @ts-check

/**
 * @typedef {Record<string,unknown>} JsonRecord
 * @typedef {{reviewStatus?:unknown;reviewFragmentId?:unknown;reviewContextId?:string;[key:string]:unknown}} OcrHint
 */

const MAX_OCR_BBOX_HINTS = 80;

/** @param {OcrHint} hint @param {JsonRecord} record */
function copyReviewContextMetadata(hint, record) {
  if (!Object.prototype.hasOwnProperty.call(record, "reviewContextId")) {
    return;
  }
  const reviewContextId = String(record.reviewContextId ?? "")
    .trim()
    .toUpperCase();
  if (!/^RC\d{3,4}$/.test(reviewContextId)) {
    throw new Error(
      `Invalid reviewContextId for OCR candidate ${String(record.id ?? "?")}.`,
    );
  }
  if (
    hint.reviewStatus !== "confirmed" ||
    !/^B\d{3,4}$/.test(String(hint.reviewFragmentId ?? ""))
  ) {
    throw new Error(
      `reviewContextId ${reviewContextId} requires confirmed axis-v4 review metadata.`,
    );
  }
  hint.reviewContextId = reviewContextId;
}

/**
 * The public OCR boundary applies to candidates, while review contexts are
 * valid only as complete relations. If the boundary cuts a valid context, keep
 * all first-page candidates but remove that optional relation atomically from
 * the retained side. Callers must validate the full input before invoking this
 * function so malformed source metadata cannot be hidden by the cap.
 *
 * @template {OcrHint} THint
 * @param {THint[]} hints
 * @returns {THint[]}
 */
function limitPartitionedHints(hints) {
  const limited = hints.slice(0, MAX_OCR_BBOX_HINTS);
  if (hints.length <= MAX_OCR_BBOX_HINTS) {
    return limited;
  }
  const truncatedContextIds = new Set(
    hints
      .slice(MAX_OCR_BBOX_HINTS)
      .map((hint) => hint.reviewContextId)
      .filter((value) => typeof value === "string"),
  );
  if (truncatedContextIds.size === 0) {
    return limited;
  }
  return limited.map((hint) =>
    hint.reviewContextId && truncatedContextIds.has(hint.reviewContextId)
      ? withoutReviewContext(hint)
      : hint,
  );
}

/**
 * @template {OcrHint} THint
 * @param {THint} hint
 * @returns {THint}
 */
function withoutReviewContext(hint) {
  const copy = { ...hint };
  delete copy.reviewContextId;
  return /** @type {THint} */ (copy);
}

module.exports = {
  MAX_OCR_BBOX_HINTS,
  copyReviewContextMetadata,
  limitPartitionedHints,
};
