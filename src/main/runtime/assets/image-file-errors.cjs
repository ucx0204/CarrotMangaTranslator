// @ts-check

/**
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 * @param {unknown} [cause]
 * @returns {Error & Record<string, unknown>}
 */
function createImageDetailedError(message, detail = {}, cause) {
  const error = /** @type {Error & Record<string, unknown>} */ (
    new Error(message)
  );
  if (cause !== undefined) {
    error.cause = cause;
  }
  Object.assign(error, detail);
  return error;
}

module.exports = { createImageDetailedError };
