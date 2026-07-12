// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {RuntimeOptions & { ocrBboxProvider?: string | null; ocrBboxMode?: unknown; ocrVersion?: unknown; ocrMergeMode?: unknown; ocrDetLimit?: unknown; ocrRecBatch?: unknown }} OcrBboxOptions */
/** @typedef {{ emitRuntimeProgress: (options: object | undefined, phase: string, progressText: string, detail?: string, progress?: Record<string, unknown>) => void; runtimeOverrideEnv: (name: string, options?: RuntimeOptions) => unknown; isPaddleOcrModelAssetLoadFailure: (error: unknown) => boolean; isOcrGpuRequested: (options?: OcrBboxOptions) => boolean; resolveOcrGpuBackend: (options?: OcrBboxOptions) => string; truncateText: (value: unknown, limit: number) => string }} Dependencies */
/** @typedef {{ dependencies: Dependencies; state: { disabled: boolean; reason: string } }} PolicyContext */

const CPU_FALLBACK_VL_MODE_FIELDS = {
  ocrBboxMode: "ocr",
  ocrVersion: "PP-OCRv6",
  ocrMergeMode: "conservative",
  ocrDetLimit: "1600",
  ocrRecBatch: "1",
};

/** @param {Dependencies} dependencies */
function createOcrGpuPolicy(dependencies) {
  const context = { dependencies, state: { disabled: false, reason: "" } };
  return {
    applyBatchSessionCpuOverride: applyBatchSessionCpuOverride.bind(
      null,
      context,
    ),
    applyOcrGpuSessionCpuOverride: applyOcrGpuSessionCpuOverride.bind(
      null,
      context,
    ),
    buildCpuFallbackOcrOptions: buildCpuFallbackOcrOptions.bind(null, context),
    canFallBackToCpuAfterGpuFailure: canFallBackToCpuAfterGpuFailure.bind(
      null,
      context,
    ),
    disableOcrGpuForSession: disableOcrGpuForSession.bind(null, context),
    isOcrGpuDisabledForSession: isOcrGpuDisabledForSession.bind(null, context),
    resetOcrGpuSessionState: resetOcrGpuSessionState.bind(null, context),
    resolveOcrBboxProvider: resolveOcrBboxProvider.bind(null, context),
    shouldApplySessionCpuOverride: shouldApplySessionCpuOverride.bind(
      null,
      context,
    ),
  };
}

/** @param {PolicyContext} context @param {unknown} reason */
function disableOcrGpuForSession(context, reason) {
  context.state.disabled = true;
  context.state.reason = String(reason ?? "");
}

/** @param {PolicyContext} context */
function isOcrGpuDisabledForSession(context) {
  return context.state.disabled;
}

/** @param {PolicyContext} context */
function resetOcrGpuSessionState(context) {
  context.state.disabled = false;
  context.state.reason = "";
}

/** @param {PolicyContext} context @param {OcrBboxOptions} [options] */
function isOcrGpuCpuFallbackDisabled(context, options = {}) {
  return isTruthy(
    context.dependencies.runtimeOverrideEnv(
      "MANGA_TRANSLATOR_OCR_GPU_NO_CPU_FALLBACK",
      options,
    ),
  );
}

/** @param {PolicyContext} context @param {OcrBboxOptions} [options] */
function isVlModeOcrOptions(context, options = {}) {
  const mode = String(options.ocrBboxMode ?? "")
    .trim()
    .toLowerCase();
  return mode
    ? mode === "vl"
    : context.dependencies.resolveOcrGpuBackend(options) !==
        "rocm-transformers";
}

/** @param {PolicyContext} context @param {OcrBboxOptions} options */
function buildCpuFallbackOcrOptions(context, options) {
  return {
    ...options,
    ...(isVlModeOcrOptions(context, options)
      ? CPU_FALLBACK_VL_MODE_FIELDS
      : {}),
    ocrDeviceOverride: "cpu",
  };
}

/** @param {PolicyContext} context @param {OcrBboxOptions} options @param {string} provider */
function shouldApplySessionCpuOverride(context, options, provider) {
  return (
    provider === "paddleocr-vl" &&
    context.state.disabled &&
    context.dependencies.isOcrGpuRequested(options) &&
    !String(options.ocrDeviceOverride ?? "").trim() &&
    !isOcrGpuCpuFallbackDisabled(context, options)
  );
}

/** @param {PolicyContext} context @param {OcrBboxOptions} options @param {string} provider */
function applyOcrGpuSessionCpuOverride(context, options, provider) {
  if (!shouldApplySessionCpuOverride(context, options, provider)) {
    return options;
  }
  const next = buildCpuFallbackOcrOptions(context, options);
  emitSessionOverrideProgress(context, next);
  return next;
}

/** @param {PolicyContext} context @param {OcrBboxOptions[]} optionsList */
function applyBatchSessionCpuOverride(context, optionsList) {
  const first = optionsList[0] || {};
  if (
    !shouldApplySessionCpuOverride(
      context,
      first,
      resolveOcrBboxProvider(context, first),
    )
  ) {
    return optionsList;
  }
  const next = optionsList.map((options) =>
    buildCpuFallbackOcrOptions(context, options),
  );
  emitSessionOverrideProgress(context, next[0]);
  return next;
}

/** @param {PolicyContext} context @param {OcrBboxOptions} options */
function emitSessionOverrideProgress(context, options) {
  context.dependencies.emitRuntimeProgress(
    options,
    "ocr_running",
    "이전 GPU OCR 실패로 이 세션에서는 CPU로 OCR을 실행합니다",
    context.dependencies.truncateText(context.state.reason, 600),
    { progressMode: "log-only" },
  );
}

/** @param {PolicyContext} context @param {OcrBboxOptions} options @param {unknown} error */
function canFallBackToCpuAfterGpuFailure(context, options, error) {
  if (isOcrGpuCpuFallbackDisabled(context, options)) {
    return false;
  }
  if (options.abortSignal?.aborted || isAbortError(error)) {
    return false;
  }
  return !context.dependencies.isPaddleOcrModelAssetLoadFailure(error);
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
  if (isEnvironmentEnabled(context, "MANGA_TRANSLATOR_PADDLEOCR_VL", options)) {
    return "paddleocr-vl";
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
    : "paddleocr-vl";
}

/** @param {PolicyContext} context @param {OcrBboxOptions} options */
function readExplicitProvider(context, options) {
  return String(
    options.ocrBboxProvider ??
      context.dependencies.runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_BBOX_PROVIDER",
        options,
      ) ??
      "",
  ).trim();
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

/** @param {unknown} error */
function isAbortError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    /** @type {{ name?: unknown }} */ (error).name === "AbortError",
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
