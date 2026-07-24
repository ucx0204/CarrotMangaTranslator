// @ts-check

const { isRecord, semanticContractError } = require("./values.cjs");

const GROUP_ONLY_REVIEW_REQUEST_FAILURE = "group-only-review-request-failed";
const GROUP_REVIEW_IMAGE_ERROR_PREFIX = "group-review-image-";

/**
 * Convert only failures explicitly classified by the model HTTP boundary into
 * a review-domain failure. Arbitrary callback exceptions remain programming
 * errors and must propagate.
 *
 * @param {unknown} error
 * @returns {unknown}
 */
function classifyGroupOnlyReviewRequestFailure(error) {
  if (!isExpectedModelRequestFailure(error)) {
    return error;
  }
  return semanticContractError(
    GROUP_ONLY_REVIEW_REQUEST_FAILURE,
    error instanceof Error
      ? error.message
      : "Group-only review request failed.",
    { cause: error },
  );
}

/** @param {unknown} error */
function isExpectedGroupOnlyReviewFailure(error) {
  if (!isRecord(error) || error instanceof TypeError) return false;
  const code = typeof error.code === "string" ? error.code : "";
  return (
    code === GROUP_ONLY_REVIEW_REQUEST_FAILURE ||
    code.startsWith("group-only-review-") ||
    isExpectedModelRequestFailure(error)
  );
}

/** @param {unknown} error */
function isExpectedGroupReviewImageFailure(error) {
  if (!isRecord(error) || error instanceof TypeError) return false;
  return (
    typeof error.code === "string" &&
    error.code.startsWith(GROUP_REVIEW_IMAGE_ERROR_PREFIX)
  );
}

/**
 * HTTP helpers attach one of these explicit markers at the model boundary.
 * `requestSummary` also marks response decoding errors created after a
 * request has completed.
 *
 * @param {unknown} error
 */
function isExpectedModelRequestFailure(error) {
  if (!isRecord(error) || error instanceof TypeError) return false;
  return (
    error.modelTransportError === true ||
    typeof error.status === "number" ||
    typeof error.failureCategory === "string" ||
    isRecord(error.requestSummary)
  );
}

/**
 * @param {string} reason
 * @param {string} message
 * @param {unknown} [cause]
 */
function groupReviewImageError(reason, message, cause) {
  return semanticContractError(
    `${GROUP_REVIEW_IMAGE_ERROR_PREFIX}${reason}`,
    message,
    cause === undefined ? {} : { cause },
  );
}

module.exports = {
  classifyGroupOnlyReviewRequestFailure,
  groupReviewImageError,
  isExpectedGroupOnlyReviewFailure,
  isExpectedGroupReviewImageFailure,
};
