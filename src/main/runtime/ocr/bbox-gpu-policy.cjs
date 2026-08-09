// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {RuntimeOptions & { ocrBboxProvider?: string | null }} OcrBboxOptions */
/** @typedef {{ runtimeOverrideEnv: (name: string, options?: RuntimeOptions) => unknown }} Dependencies */
/** @typedef {{ dependencies: Dependencies }} PolicyContext */

/** @param {Dependencies} dependencies */
function createOcrGpuPolicy(dependencies) {
  const context = { dependencies };
  return {
    resolveOcrBboxProvider: resolveOcrBboxProvider.bind(null, context),
  };
}

/** @param {PolicyContext} context @param {OcrBboxOptions} [options] */
function resolveOcrBboxProvider(context, options = {}) {
  const explicit = readExplicitProvider(context, options);
  if (explicit) {
    return explicit;
  }
  if (
    isEnvironmentEnabled(context, "MANGA_TRANSLATOR_DISABLE_OCR_BBOX", options)
  ) {
    return "none";
  }
  if (hasEnvironmentValue(context, "MANGA_TRANSLATOR_OCR_BBOX_CMD", options)) {
    return "external-command";
  }
  return hasEnvironmentValue(
    context,
    "MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH",
    options,
  )
    ? "json-file"
    : "paddleocr";
}

/** @param {PolicyContext} context @param {OcrBboxOptions} options */
function readExplicitProvider(context, options) {
  const provider = String(
    options.ocrBboxProvider ??
      context.dependencies.runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_BBOX_PROVIDER",
        options,
      ) ??
      "",
  ).trim();
  // Compatibility-only alias: the former provider name now resolves to the
  // supported PP-OCRv6 implementation and cannot select the removed VL path.
  return provider === "paddleocr-vl" ? "paddleocr" : provider;
}

/** @param {PolicyContext} context @param {string} name @param {OcrBboxOptions} options */
function isEnvironmentEnabled(context, name, options) {
  return isTruthy(context.dependencies.runtimeOverrideEnv(name, options));
}

/** @param {PolicyContext} context @param {string} name @param {OcrBboxOptions} options */
function hasEnvironmentValue(context, name, options) {
  return Boolean(
    String(context.dependencies.runtimeOverrideEnv(name, options) ?? "").trim(),
  );
}

/** @param {unknown} value */
function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

module.exports = { createOcrGpuPolicy };
