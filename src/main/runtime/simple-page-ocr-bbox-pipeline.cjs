// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/**
 * @typedef {RuntimeOptions & {
 *   ocrBboxHints?: unknown;
 *   ocrBboxHintsPath?: string | null;
 *   ocrBboxProvider?: string | null;
 *   ocrBboxResult?: unknown;
 *   skipOcrBboxHints?: boolean | null;
 * }} OcrBboxOptions
 * @typedef {Record<string, unknown>} OcrBboxHint
 * @typedef {Record<string, unknown>} OcrBboxDiagnostic
 * @typedef {{ noTextDetected?: boolean; textEvidenceCount?: number }} OcrBboxResultOptions
 * @typedef {{ hints: unknown[]; diagnostics: unknown[]; noTextDetected: boolean; textEvidenceCount: number }} OcrBboxResult
 * @typedef {{ timeoutMs?: number; onOutput?: ((line: string) => void) | null }} OcrShellRunOptions
 */
const { existsSync, readFileSync } = require("node:fs");
const { mkdir, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  extractJsonText,
  normalizeOcrBboxHintPayload,
} = require("./simple-page-ocr-hints.cjs");
const {
  createOcrBatchProgressFilePoller,
  parseOcrBatchProgressLine,
  resolveOcrBboxTimeoutMs,
} = require("./simple-page-progress.cjs");
const {
  readOcrCandidateText,
  readPositiveInteger,
} = require("./simple-page-prompts.cjs");
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");
const {
  buildOcrRuntimeEnv,
  buildPaddleOcrGpuFailureMessage,
  isOcrGpuRequested,
  resolveEffectiveOcrDevice,
  resolveOcrDevice,
  resolveOcrDeviceLabel,
  resolveOcrGpuBackend,
  summarizeOcrErrorMessage,
} = require("./simple-page-ocr-runtime-config.cjs");
const {
  createOcrCommandProgressHandler,
} = require("./simple-page-ocr-progress-handlers.cjs");
const {
  buildOcrBboxBatchCommand,
  buildOcrBboxCommand,
} = require("./simple-page-ocr-commands.cjs");
const {
  createOcrRuntimeError,
  ensurePaddleOcrRuntime,
} = require("./simple-page-ocr-runtime-manager.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  safeCleanup,
  truncateText,
} = require("./simple-page-runtime-common.cjs");
const {
  isPaddleOcrModelAssetLoadFailure,
  repairPaddleOcrModelAssetsCache,
} = require("./simple-page-model-assets.cjs");
const { runShellCommand } = require("./simple-page-shell-utils.cjs");

/**
 * Once GPU OCR fails in this process, the rest of the session runs OCR on
 * CPU instead of retrying a GPU stack that already proved unstable.
 */
const ocrGpuSessionState = { disabled: false, reason: "" };

/** @param {unknown} reason */
function disableOcrGpuForSession(reason) {
  ocrGpuSessionState.disabled = true;
  ocrGpuSessionState.reason = String(reason ?? "");
}

function isOcrGpuDisabledForSession() {
  return ocrGpuSessionState.disabled;
}

function resetOcrGpuSessionState() {
  ocrGpuSessionState.disabled = false;
  ocrGpuSessionState.reason = "";
}

/**
 * @param {OcrBboxOptions} [options]
 * @returns {boolean}
 */
function isOcrGpuCpuFallbackDisabled(options = {}) {
  return isTruthy(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_NO_CPU_FALLBACK", options),
  );
}

/**
 * The full-quality VL layout pipeline is unusably slow on CPU, so a CPU
 * fallback of a VL run downgrades to the plain PP-OCRv6 text-line path.
 * The PP-OCRv6 server det/rec models are already cached because the VL run
 * uses them as its text-line detector, so no new downloads are needed.
 */
const CPU_FALLBACK_VL_MODE_FIELDS = {
  ocrBboxMode: "ocr",
  ocrVersion: "PP-OCRv6",
  ocrMergeMode: "conservative",
  ocrDetLimit: "1600",
  ocrRecBatch: "1",
};

/**
 * @param {OcrBboxOptions} [options]
 * @returns {boolean}
 */
function isVlModeOcrOptions(options = {}) {
  const bboxMode = String(options.ocrBboxMode ?? "")
    .trim()
    .toLowerCase();
  if (bboxMode) {
    return bboxMode === "vl";
  }
  // Unset mode defaults to VL except on the rocm-transformers path, which
  // always forces the ocr-only text-line mode.
  return resolveOcrGpuBackend(options) !== "rocm-transformers";
}

/**
 * @param {OcrBboxOptions} options
 * @returns {OcrBboxOptions}
 */
function buildCpuFallbackOcrOptions(options) {
  return {
    ...options,
    ...(isVlModeOcrOptions(options) ? CPU_FALLBACK_VL_MODE_FIELDS : {}),
    ocrDeviceOverride: "cpu",
  };
}

/**
 * @param {OcrBboxOptions} options
 * @param {string} provider
 * @returns {boolean}
 */
function shouldApplySessionCpuOverride(options, provider) {
  return (
    provider === "paddleocr-vl" &&
    ocrGpuSessionState.disabled &&
    isOcrGpuRequested(options) &&
    !String(options.ocrDeviceOverride ?? "").trim() &&
    !isOcrGpuCpuFallbackDisabled(options)
  );
}

/**
 * @param {OcrBboxOptions} options
 * @param {string} provider
 * @returns {OcrBboxOptions}
 */
function applyOcrGpuSessionCpuOverride(options, provider) {
  if (!shouldApplySessionCpuOverride(options, provider)) {
    return options;
  }
  const next = buildCpuFallbackOcrOptions(options);
  emitRuntimeProgress(
    next,
    "ocr_running",
    "이전 GPU OCR 실패로 이 세션에서는 CPU로 OCR을 실행합니다",
    truncateText(ocrGpuSessionState.reason, 600),
    { progressMode: "log-only" },
  );
  return next;
}

/**
 * @param {OcrBboxOptions} options
 * @param {unknown} error
 * @returns {boolean}
 */
function canFallBackToCpuAfterGpuFailure(options, error) {
  if (isOcrGpuCpuFallbackDisabled(options)) {
    return false;
  }
  if (options.abortSignal?.aborted || isAbortError(error)) {
    return false;
  }
  // Model cache corruption is not a GPU problem; the model-repair retry
  // already handled it once and rerunning on CPU would hit the same error.
  return !isPaddleOcrModelAssetLoadFailure(error);
}

/** @param {unknown} error */
function isAbortError(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    /** @type {{ name?: unknown }} */ (error).name === "AbortError",
  );
}

/**
 * @param {OcrBboxOptions} [options]
 * @returns {string}
 */
function resolveOcrBboxProvider(options = {}) {
  const explicit = String(
    options.ocrBboxProvider ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_PROVIDER", options) ??
      "",
  ).trim();
  if (explicit) {
    return explicit;
  }
  if (
    isTruthy(runtimeOverrideEnv("MANGA_TRANSLATOR_DISABLE_OCR_BBOX", options))
  ) {
    return "none";
  }
  if (isTruthy(runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_VL", options))) {
    return "paddleocr-vl";
  }
  if (
    String(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_CMD", options) ?? "",
    ).trim()
  ) {
    return "external-command";
  }
  if (
    String(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH", options) ?? "",
    ).trim()
  ) {
    return "json-file";
  }
  return "paddleocr-vl";
}

/**
 * @param {OcrBboxOptions} [options]
 * @returns {Promise<OcrBboxResult>}
 */
async function collectOcrBboxHints(options = {}) {
  /** @type {OcrBboxDiagnostic[]} */
  const diagnostics = [];
  if (options.skipOcrBboxHints) {
    return buildOcrBboxResult(
      [],
      [{ provider: "disabled", reason: "skipOcrBboxHints" }],
      { noTextDetected: false },
    );
  }

  if (Object.prototype.hasOwnProperty.call(options, "ocrBboxResult")) {
    const result = normalizeOcrBboxResultPayload(
      options.ocrBboxResult,
      options,
    );
    return buildOcrBboxResult(result.hints, result.diagnostics, {
      noTextDetected: result.noTextDetected,
      textEvidenceCount: result.textEvidenceCount,
    });
  }

  const inlineHints = normalizeOcrBboxHintPayload(
    options.ocrBboxHints,
    options,
  );
  if (Object.prototype.hasOwnProperty.call(options, "ocrBboxHints")) {
    return buildOcrBboxResult(inlineHints, [
      {
        provider: "inline",
        hintCount: inlineHints.length,
      },
    ]);
  }

  const hintsPath = String(
    options.ocrBboxHintsPath ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH", options) ??
      "",
  ).trim();
  if (hintsPath) {
    try {
      const rawText = await readFile(hintsPath, "utf8");
      const hints = normalizeOcrBboxHintPayload(JSON.parse(rawText), options);
      return buildOcrBboxResult(hints, [
        { provider: "json-file", path: hintsPath },
      ]);
    } catch (error) {
      diagnostics.push(
        buildOcrBboxDiagnostic("json-file", error, { path: hintsPath }),
      );
    }
  }

  const provider = resolveOcrBboxProvider(options);
  if (provider === "none" || provider === "json-file") {
    return buildOcrBboxResult([], diagnostics, { noTextDetected: false });
  }

  const runOptions = applyOcrGpuSessionCpuOverride(options, provider);
  try {
    return await runProviderOcrBbox(runOptions, provider);
  } catch (error) {
    diagnostics.push(buildOcrBboxDiagnostic(provider, error));
    const gpuExecutionFailed =
      provider === "paddleocr-vl" &&
      isOcrGpuRequested(runOptions) &&
      resolveEffectiveOcrDevice(runOptions) !== "cpu";
    if (!gpuExecutionFailed) {
      return buildOcrBboxResult([], diagnostics, { noTextDetected: false });
    }
    const failureMessage = buildPaddleOcrGpuFailureMessage(error, runOptions);
    if (!canFallBackToCpuAfterGpuFailure(runOptions, error)) {
      emitRuntimeProgress(
        runOptions,
        "ocr_running",
        "Paddle OCR GPU 실행 실패",
        failureMessage,
      );
      throw createOcrRuntimeError(failureMessage, { diagnostics }, error);
    }
    disableOcrGpuForSession(failureMessage);
    emitRuntimeProgress(
      runOptions,
      "ocr_running",
      "Paddle OCR GPU 실행 실패 — CPU로 다시 시도합니다",
      failureMessage,
      { progressMode: "log-only" },
    );
    try {
      return await runProviderOcrBbox(
        buildCpuFallbackOcrOptions(runOptions),
        provider,
      );
    } catch (cpuError) {
      diagnostics.push(
        buildOcrBboxDiagnostic(provider, cpuError, { stage: "cpu-fallback" }),
      );
      emitRuntimeProgress(
        runOptions,
        "ocr_running",
        "Paddle OCR GPU/CPU 실행 실패",
        failureMessage,
      );
      throw createOcrRuntimeError(
        `${failureMessage} CPU 폴백 실행도 실패했습니다. cpuDetail=${truncateText(summarizeOcrErrorMessage(cpuError), 800)}`,
        { diagnostics },
        cpuError,
      );
    }
  }
}

/**
 * @param {OcrBboxOptions} options
 * @param {string} provider
 * @returns {Promise<OcrBboxResult>}
 */
async function runProviderOcrBbox(options, provider) {
  emitRuntimeProgress(
    options,
    "ocr_preparing",
    "Paddle OCR 준비 중",
    `장치: ${resolveOcrDeviceLabel(options)}`,
  );
  const commandResult = await runOcrBboxCommand(options, provider);
  const hints = normalizeOcrBboxHintPayload(commandResult.payload, options);
  const result = buildOcrBboxResult(hints, [
    {
      provider,
      command: commandResult.command,
      outputPath: commandResult.outputPath,
      runtimeDir: commandResult.runtimeDir || null,
      runtimeVariant: commandResult.runtimeVariant || null,
      packageDir: commandResult.packageDir || null,
      pythonPath: commandResult.pythonPath || null,
      runtimePrepared: commandResult.runtimePrepared || false,
      hintCount: hints.length,
      stdoutPreview: truncateText(commandResult.stdout.trim(), 1200),
      stderrPreview: truncateText(commandResult.stderr.trim(), 1200),
      runtimeDiagnostics: commandResult.runtimeDiagnostics || [],
    },
  ]);
  emitRuntimeProgress(
    options,
    "ocr_running",
    result.noTextDetected
      ? "Paddle OCR 텍스트 없음"
      : `Paddle OCR 후보 ${hints.length}개 감지`,
    result.noTextDetected
      ? `장치: ${resolveOcrDeviceLabel(options)}, 텍스트 근거 없음`
      : `장치: ${resolveOcrDeviceLabel(options)}`,
  );
  return result;
}

/**
 * @param {unknown[]} [hints]
 * @param {unknown[]} [diagnostics]
 * @param {OcrBboxResultOptions} [options]
 * @returns {OcrBboxResult}
 */
function buildOcrBboxResult(hints = [], diagnostics = [], options = {}) {
  const normalizedHints = Array.isArray(hints) ? hints : [];
  const configuredTextEvidenceCount = Number(options.textEvidenceCount);
  const textEvidenceCount =
    Number.isFinite(configuredTextEvidenceCount) &&
    configuredTextEvidenceCount >= 0
      ? configuredTextEvidenceCount
      : countOcrTextEvidence(normalizedHints);
  const noTextDetected =
    typeof options.noTextDetected === "boolean"
      ? options.noTextDetected
      : normalizedHints.length === 0;
  return {
    hints: normalizedHints,
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    noTextDetected,
    textEvidenceCount,
  };
}

/**
 * @param {unknown} value
 * @param {OcrBboxOptions} [options]
 */
function normalizeOcrBboxResultPayload(value, options = {}) {
  const record =
    value && typeof value === "object"
      ? /** @type {{ hints?: unknown; diagnostics?: unknown; noTextDetected?: unknown; textEvidenceCount?: unknown }} */ (
          value
        )
      : {};
  const hints = normalizeOcrBboxHintPayload(record.hints, options);
  const textEvidenceCount = Number(record.textEvidenceCount);
  return {
    hints,
    diagnostics: Array.isArray(record.diagnostics) ? record.diagnostics : [],
    noTextDetected:
      typeof record.noTextDetected === "boolean"
        ? record.noTextDetected
        : undefined,
    textEvidenceCount:
      Number.isFinite(textEvidenceCount) && textEvidenceCount >= 0
        ? textEvidenceCount
        : undefined,
  };
}

/** @param {unknown[]} [hints] */
function countOcrTextEvidence(hints = []) {
  let count = 0;
  for (const hint of hints) {
    if (hasJapaneseTextEvidence(readOcrCandidateText(hint))) {
      count += 1;
    }
  }
  return count;
}

/** @param {unknown} value */
function hasJapaneseTextEvidence(value) {
  const text = String(value ?? "");
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x31f0 && code <= 0x31ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      code === 0x3005 ||
      code === 0x30fc
    ) {
      return true;
    }
  }
  return false;
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
    message: summarizeOcrErrorMessage(error),
    ...extra,
  };
}

/**
 * @param {OcrBboxOptions} [options]
 * @param {string} [provider]
 */
async function runOcrBboxCommand(options = {}, provider = "external-command") {
  const outputDir = options.outputDir || process.cwd();
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "ocr-bbox-hints.json");
  const runtime =
    provider === "paddleocr-vl" ? await ensurePaddleOcrRuntime(options) : null;
  const command = buildOcrBboxCommand(options, provider, outputPath, runtime);
  emitRuntimeProgress(
    options,
    "ocr_running",
    "Paddle OCR 모델 다운로드/위치 분석 중",
    `장치: ${resolveOcrDeviceLabel(options)}`,
  );
  const handleOcrOutput = createOcrCommandProgressHandler(options, {
    progressText: "Paddle OCR 모델 다운로드/위치 분석 중",
  });
  const { stdout, stderr } = await runOcrShellCommandWithModelRepair(
    command,
    options,
    runtime,
    {
      timeoutMs: resolveOcrBboxTimeoutMs(1),
      onOutput: handleOcrOutput,
    },
  );

  let rawText;
  if (existsSync(outputPath)) {
    rawText = await readFile(outputPath, "utf8");
  } else {
    rawText = extractJsonText(stdout);
  }

  if (!rawText.trim()) {
    throw createDetailedError("OCR bbox command did not produce JSON.", {
      command,
      outputPath,
      stdoutPreview: truncateText(stdout, 2000),
      stderrPreview: truncateText(stderr, 2000),
    });
  }

  return {
    command,
    outputPath,
    runtimeDir: runtime?.runtimeDir || null,
    runtimeVariant: runtime?.runtimeVariant || null,
    packageDir: runtime?.packageDir || null,
    pythonPath: runtime?.pythonPath || null,
    runtimePrepared: Boolean(runtime?.prepared),
    runtimeDiagnostics: runtime?.diagnostics || [],
    stdout,
    stderr,
    payload: JSON.parse(rawText),
  };
}

/**
 * @param {OcrBboxOptions[]} [pageOptionsList]
 * @returns {Promise<OcrBboxResult[]>}
 */
async function collectOcrBboxHintsBatch(pageOptionsList = []) {
  let normalizedOptions = pageOptionsList.filter(Boolean);
  if (normalizedOptions.length === 0) {
    return [];
  }

  if (
    shouldApplySessionCpuOverride(
      normalizedOptions[0] || {},
      resolveOcrBboxProvider(normalizedOptions[0] || {}),
    )
  ) {
    normalizedOptions = normalizedOptions.map((options) =>
      buildCpuFallbackOcrOptions(options),
    );
    emitRuntimeProgress(
      normalizedOptions[0],
      "ocr_running",
      "이전 GPU OCR 실패로 이 세션에서는 CPU로 OCR을 실행합니다",
      truncateText(ocrGpuSessionState.reason, 600),
      { progressMode: "log-only" },
    );
  }

  const firstOptions = normalizedOptions[0] || {};
  const batchOptions = withoutPageProgressOptions(firstOptions);
  const provider = resolveOcrBboxProvider(firstOptions);
  if (provider !== "paddleocr-vl") {
    const results = [];
    for (const options of normalizedOptions) {
      results.push(await collectOcrBboxHints(options));
    }
    return results;
  }

  const runtime = await ensurePaddleOcrRuntime(batchOptions);
  const batchPath = path.join(
    firstOptions.outputDir || process.cwd(),
    `ocr-batch-${Date.now()}-${process.pid}.json`,
  );
  const progressPath = path.join(
    firstOptions.outputDir || process.cwd(),
    `ocr-batch-progress-${Date.now()}-${process.pid}.jsonl`,
  );
  const items = normalizedOptions.map((options, index) => {
    const outputDir =
      options.outputDir ||
      path.join(firstOptions.outputDir || process.cwd(), `page-${index + 1}`);
    return {
      image: options.imagePath,
      output: path.join(outputDir, "ocr-bbox-hints.json"),
    };
  });
  await mkdir(path.dirname(batchPath), { recursive: true });
  for (const item of items) {
    await mkdir(path.dirname(item.output), { recursive: true });
  }
  // Remove stale outputs from an earlier run so the CPU-fallback resume scan
  // cannot mistake them for pages completed by this run.
  for (const item of items) {
    await rm(item.output, { force: true });
  }

  const cpuWorkerCount = resolveOcrCpuWorkerCount(
    batchOptions,
    normalizedOptions.length,
  );
  if (
    isExplicitCpuOcrDevice(batchOptions) &&
    resolveOcrDevice(batchOptions) === "cpu" &&
    cpuWorkerCount > 1
  ) {
    return await collectOcrBboxHintsBatchInCpuWorkers({
      batchOptions,
      firstOptions,
      items,
      normalizedOptions,
      provider,
      runtime,
      workerCount: cpuWorkerCount,
    });
  }

  await writeFile(batchPath, `${JSON.stringify({ items }, null, 2)}\n`, "utf8");
  await writeFile(progressPath, "", "utf8");

  const command = buildOcrBboxBatchCommand(
    batchOptions,
    batchPath,
    runtime,
    progressPath,
  );
  emitRuntimeProgress(
    batchOptions,
    "ocr_running",
    "Paddle OCR 배치 위치 분석 중",
    `${items.length}페이지, 장치: ${resolveOcrDeviceLabel(batchOptions)}`,
    {
      pageIndex: null,
      pageTotal: null,
      progressCurrent:
        readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0,
      progressTotal:
        readPositiveInteger(firstOptions.ocrBatchTotal) || items.length,
    },
  );
  const seenProgressEvents = new Set();
  const handleCommandOutput = createOcrCommandProgressHandler(batchOptions, {
    progressText: "Paddle OCR 배치 위치 분석 중",
    progressCurrent:
      readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0,
    progressTotal:
      readPositiveInteger(firstOptions.ocrBatchTotal) || items.length,
  });
  const emitPageProgress = createOcrBatchProgressEmitter(
    batchOptions,
    firstOptions,
    normalizedOptions,
  );
  /** @param {string} line */
  const handleProgressLine = (line) => {
    const progress = parseOcrBatchProgressLine(line);
    if (!progress) {
      handleCommandOutput(line);
      return;
    }
    const phase = progress.phase || "done";
    const eventKey = `${phase}:${progress.index}:${progress.total}`;
    if (seenProgressEvents.has(eventKey)) {
      return;
    }
    seenProgressEvents.add(eventKey);
    emitPageProgress({
      itemIndex: progress.index - 1,
      phase,
      count: Number(progress.count) || 0,
    });
  };
  const progressPoller = createOcrBatchProgressFilePoller(
    progressPath,
    handleProgressLine,
  );
  const cpuFallbackRun =
    String(batchOptions.ocrDeviceOverride ?? "")
      .trim()
      .toLowerCase() === "cpu";
  let stdout = "";
  let stderr = "";
  try {
    progressPoller.start();
    ({ stdout, stderr } = await runOcrShellCommandWithModelRepair(
      command,
      batchOptions,
      runtime,
      {
        timeoutMs: resolveOcrBboxTimeoutMs(items.length),
        onOutput: handleProgressLine,
      },
    ));

    return normalizedOptions.map((options, index) => {
      const outputPath = items[index].output;
      let payload = null;
      if (existsSync(outputPath)) {
        payload = JSON.parse(readFileSync(outputPath, "utf8"));
      }
      if (!payload) {
        if (cpuFallbackRun) {
          // A page that still failed on CPU is skipped instead of failing the
          // whole batch. noTextDetected stays false so downstream does not
          // treat the page as "no text on page".
          return buildOcrBboxResult(
            [],
            [
              {
                provider,
                reason: "page-ocr-failed",
                message: truncateText(stderr.trim() || stdout.trim(), 800),
                outputPath,
              },
            ],
            { noTextDetected: false },
          );
        }
        throw createDetailedError(
          "OCR bbox batch command did not produce JSON.",
          {
            command,
            outputPath,
            stdoutPreview: truncateText(stdout, 2000),
            stderrPreview: truncateText(stderr, 2000),
          },
        );
      }
      const hints = normalizeOcrBboxHintPayload(payload, options);
      return buildOcrBboxResult(hints, [
        {
          provider,
          command,
          outputPath,
          runtimeDir: runtime?.runtimeDir || null,
          runtimeVariant: runtime?.runtimeVariant || null,
          packageDir: runtime?.packageDir || null,
          pythonPath: runtime?.pythonPath || null,
          runtimePrepared: Boolean(runtime?.prepared),
          hintCount: hints.length,
          stdoutPreview: truncateText(stdout.trim(), 1200),
          stderrPreview: truncateText(stderr.trim(), 1200),
          runtimeDiagnostics: runtime?.diagnostics || [],
        },
      ]);
    });
  } catch (error) {
    progressPoller.stop();
    const fallbackResults = await recoverOcrBatchWithCpuFallback({
      error,
      batchOptions,
      firstOptions,
      items,
      normalizedOptions,
      provider,
      runtime,
    });
    if (fallbackResults) {
      return fallbackResults;
    }
    throw error;
  } finally {
    progressPoller.stop();
    await cleanupOcrBatchControlFiles(batchPath, progressPath, batchOptions);
  }
}

/**
 * Resumes a GPU batch that died midway: pages whose output JSON already
 * exists are kept, the remaining pages rerun on CPU via a recursive batch
 * call, and the merged results come back in the original page order.
 * Returns null when the failure should propagate instead of falling back.
 * @param {{
 *   error: unknown;
 *   batchOptions: OcrBboxOptions;
 *   firstOptions: OcrBboxOptions;
 *   items: Array<{ image: unknown; output: string }>;
 *   normalizedOptions: OcrBboxOptions[];
 *   provider: string;
 *   runtime: OcrRuntimeLayout | null;
 * }} params
 * @returns {Promise<OcrBboxResult[] | null>}
 */
async function recoverOcrBatchWithCpuFallback({
  error,
  batchOptions,
  firstOptions,
  items,
  normalizedOptions,
  provider,
  runtime,
}) {
  if (
    !isOcrGpuRequested(batchOptions) ||
    resolveEffectiveOcrDevice(batchOptions) === "cpu" ||
    !canFallBackToCpuAfterGpuFailure(batchOptions, error)
  ) {
    return null;
  }

  const failureMessage = buildPaddleOcrGpuFailureMessage(error, batchOptions);
  disableOcrGpuForSession(failureMessage);

  const completedPayloads = new Map();
  for (const [index, item] of items.entries()) {
    const payload = readCompletedOcrBatchOutputPayload(item.output);
    if (payload !== null) {
      completedPayloads.set(index, payload);
    }
  }

  const completedBefore =
    readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0;
  const batchTotal =
    readPositiveInteger(firstOptions.ocrBatchTotal) || normalizedOptions.length;
  const remaining = [];
  for (const [index, options] of normalizedOptions.entries()) {
    if (completedPayloads.has(index)) {
      continue;
    }
    remaining.push({
      index,
      options: {
        ...buildCpuFallbackOcrOptions(options),
        outputDir: path.dirname(items[index].output),
        ocrBatchCompletedBefore: completedBefore + completedPayloads.size,
        ocrBatchTotal: batchTotal,
      },
    });
  }

  emitRuntimeProgress(
    batchOptions,
    "ocr_running",
    `Paddle OCR GPU 실행 실패 — 남은 ${remaining.length}페이지를 CPU로 이어서 처리합니다`,
    failureMessage,
    { progressMode: "log-only" },
  );

  const fallbackResults =
    remaining.length > 0
      ? await collectOcrBboxHintsBatch(remaining.map((entry) => entry.options))
      : [];
  const resultByIndex = new Map();
  for (const [position, entry] of remaining.entries()) {
    resultByIndex.set(entry.index, fallbackResults[position]);
  }

  return normalizedOptions.map((options, index) => {
    const fallbackResult = resultByIndex.get(index);
    if (fallbackResult) {
      return fallbackResult;
    }
    const hints = normalizeOcrBboxHintPayload(
      completedPayloads.get(index),
      options,
    );
    return buildOcrBboxResult(hints, [
      {
        provider,
        outputPath: items[index].output,
        runtimeDir: runtime?.runtimeDir || null,
        runtimeVariant: runtime?.runtimeVariant || null,
        packageDir: runtime?.packageDir || null,
        pythonPath: runtime?.pythonPath || null,
        runtimePrepared: Boolean(runtime?.prepared),
        hintCount: hints.length,
        resumedFrom: "gpu",
        runtimeDiagnostics: runtime?.diagnostics || [],
      },
    ]);
  });
}

/**
 * Reads a per-page batch output written by the Python side. Partial files
 * left by a crashed process fail JSON.parse and count as incomplete.
 * @param {string} outputPath
 * @returns {unknown}
 */
function readCompletedOcrBatchOutputPayload(outputPath) {
  if (!existsSync(outputPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(outputPath, "utf8"));
  } catch (_error) {
    return null;
  }
}

/**
 * @param {OcrBboxOptions} [options]
 * @returns {boolean}
 */
function isExplicitCpuOcrDevice(options = {}) {
  return [
    options.ocrDevice,
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options),
    runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_DEVICE", options),
  ].some(
    (value) =>
      String(value ?? "")
        .trim()
        .toLowerCase() === "cpu",
  );
}

/**
 * @param {{
 *   batchOptions: OcrBboxOptions;
 *   firstOptions: OcrBboxOptions;
 *   items: Array<{ image: unknown; output: string }>;
 *   normalizedOptions: OcrBboxOptions[];
 *   provider: string;
 *   runtime: OcrRuntimeLayout | null;
 *   workerCount: number;
 * }} params
 * @returns {Promise<OcrBboxResult[]>}
 */
async function collectOcrBboxHintsBatchInCpuWorkers({
  batchOptions,
  firstOptions,
  items,
  normalizedOptions,
  provider,
  runtime,
  workerCount,
}) {
  const chunks = chunkOcrBatchItems(items, workerCount);
  emitRuntimeProgress(
    batchOptions,
    "ocr_running",
    "Paddle OCR CPU 병렬 배치 위치 분석 중",
    `${items.length}페이지, ${chunks.length}워커, 워커당 ${resolveOcrWorkerThreadCount(batchOptions)}스레드`,
    {
      pageIndex: null,
      pageTotal: null,
      progressCurrent:
        readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0,
      progressTotal:
        readPositiveInteger(firstOptions.ocrBatchTotal) || items.length,
    },
  );

  const emitPageProgress = createOcrBatchProgressEmitter(
    batchOptions,
    firstOptions,
    normalizedOptions,
  );
  const workerStartDelayMs = resolveOcrCpuWorkerStartDelayMs(batchOptions);
  const chunkRunPromises = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    if (chunkIndex > 0) {
      await delayForOcrWorkerStart(
        workerStartDelayMs,
        batchOptions.abortSignal,
      );
    }
    await waitForOcrCpuWorkerRamHeadroom(batchOptions, chunkIndex);
    const runPromise = runOcrBboxBatchChunk({
      batchOptions,
      chunk,
      chunkIndex,
      emitPageProgress,
      firstOptions,
      runtime,
    });
    runPromise.catch(() => {
      // Rejections are surfaced by the Promise.all below; this guard only
      // prevents an unhandledRejection during the staggered worker-start waits.
    });
    chunkRunPromises.push(runPromise);
  }
  const chunkRuns = await Promise.all(chunkRunPromises);
  const runByItemIndex = new Map();
  for (const run of chunkRuns) {
    for (const itemIndex of run.itemIndexes) {
      runByItemIndex.set(itemIndex, run);
    }
  }

  return normalizedOptions.map((options, index) => {
    const outputPath = items[index].output;
    const payload = readOcrBatchOutputPayload(outputPath);
    if (!payload) {
      const run = runByItemIndex.get(index) || {};
      throw createDetailedError(
        "OCR bbox batch command did not produce JSON.",
        {
          command: run.command,
          outputPath,
          stdoutPreview: truncateText(run.stdout, 2000),
          stderrPreview: truncateText(run.stderr, 2000),
        },
      );
    }
    const run = runByItemIndex.get(index) || {};
    const hints = normalizeOcrBboxHintPayload(payload, options);
    return buildOcrBboxResult(hints, [
      {
        provider,
        command: run.command,
        outputPath,
        runtimeDir: runtime?.runtimeDir || null,
        runtimeVariant: runtime?.runtimeVariant || null,
        packageDir: runtime?.packageDir || null,
        pythonPath: runtime?.pythonPath || null,
        runtimePrepared: Boolean(runtime?.prepared),
        hintCount: hints.length,
        stdoutPreview: truncateText(String(run.stdout || "").trim(), 1200),
        stderrPreview: truncateText(String(run.stderr || "").trim(), 1200),
        runtimeDiagnostics: runtime?.diagnostics || [],
      },
    ]);
  });
}

/**
 * @param {{
 *   batchOptions: OcrBboxOptions;
 *   chunk: { items: Array<{ image: unknown; output: string }>; itemIndexes: number[] };
 *   chunkIndex: number;
 *   emitPageProgress: (progress: { itemIndex: number; phase: string; count: number }) => void;
 *   firstOptions: OcrBboxOptions;
 *   runtime: OcrRuntimeLayout | null;
 * }} params
 * @returns {Promise<{ command: string; itemIndexes: number[]; stdout: string; stderr: string }>}
 */
async function runOcrBboxBatchChunk({
  batchOptions,
  chunk,
  chunkIndex,
  emitPageProgress,
  firstOptions,
  runtime,
}) {
  const baseDir = firstOptions.outputDir || process.cwd();
  const suffix = `${Date.now()}-${process.pid}-${chunkIndex + 1}`;
  const batchPath = path.join(baseDir, `ocr-batch-${suffix}.json`);
  const progressPath = path.join(baseDir, `ocr-batch-progress-${suffix}.jsonl`);
  await mkdir(path.dirname(batchPath), { recursive: true });
  await writeFile(
    batchPath,
    `${JSON.stringify({ items: chunk.items }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(progressPath, "", "utf8");

  const command = buildOcrBboxBatchCommand(
    {
      ...batchOptions,
      ocrWorkerThreads: resolveOcrWorkerThreadCount(batchOptions),
    },
    batchPath,
    runtime,
    progressPath,
  );
  const seenProgressEvents = new Set();
  const handleCommandOutput = createOcrCommandProgressHandler(batchOptions, {
    progressText: "Paddle OCR CPU 병렬 배치 위치 분석 중",
    progressCurrent:
      readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0,
    progressTotal:
      readPositiveInteger(firstOptions.ocrBatchTotal) || chunk.items.length,
  });
  /** @param {string} line */
  const handleProgressLine = (line) => {
    const progress = parseOcrBatchProgressLine(line);
    if (!progress) {
      handleCommandOutput(line);
      return;
    }
    const localIndex = Math.max(1, Number(progress.index) || 1);
    const itemIndex = chunk.itemIndexes[localIndex - 1];
    if (itemIndex === undefined) {
      return;
    }
    const phase = progress.phase || "done";
    const eventKey = `${chunkIndex}:${phase}:${progress.index}:${progress.total}`;
    if (seenProgressEvents.has(eventKey)) {
      return;
    }
    seenProgressEvents.add(eventKey);
    emitPageProgress({
      itemIndex,
      phase,
      count: Number(progress.count) || 0,
    });
  };
  const progressPoller = createOcrBatchProgressFilePoller(
    progressPath,
    handleProgressLine,
  );
  try {
    progressPoller.start();
    const { stdout, stderr } = await runOcrShellCommandWithModelRepair(
      command,
      {
        ...batchOptions,
        ocrWorkerThreads: resolveOcrWorkerThreadCount(batchOptions),
      },
      runtime,
      {
        timeoutMs: resolveOcrBboxTimeoutMs(chunk.items.length),
        onOutput: handleProgressLine,
      },
    );
    return { command, itemIndexes: chunk.itemIndexes, stdout, stderr };
  } finally {
    progressPoller.stop();
    await cleanupOcrBatchControlFiles(batchPath, progressPath, batchOptions);
  }
}

/**
 * Builds a stateful progress emitter for a single OCR batch. It tracks how many
 * pages have *completed* (a monotonically increasing counter) rather than which
 * page index just finished, so parallel CPU workers — or out-of-order completions
 * within one process — never make the displayed counter jump backwards.
 * @param {OcrBboxOptions} batchOptions
 * @param {OcrBboxOptions} firstOptions
 * @param {OcrBboxOptions[]} normalizedOptions
 * @returns {(progress: { itemIndex: number; phase: string; count: number }) => void}
 */
function createOcrBatchProgressEmitter(
  batchOptions,
  firstOptions,
  normalizedOptions,
) {
  const completedBefore =
    readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0;
  const batchTotal =
    readPositiveInteger(firstOptions.ocrBatchTotal) || normalizedOptions.length;
  let completed = completedBefore;
  return ({ itemIndex, phase, count }) => {
    const pageOptions = normalizedOptions[itemIndex] || firstOptions;
    const pageTotal =
      readPositiveInteger(pageOptions.ocrPageTotal) || batchTotal;
    if (phase !== "start") {
      completed = Math.min(pageTotal, completed + 1);
    }
    const label = Math.min(
      pageTotal,
      phase === "start" ? completed + 1 : completed,
    );
    emitRuntimeProgress(
      batchOptions,
      "ocr_running",
      phase === "error"
        ? `${label} / ${pageTotal} 페이지 OCR 실패 (건너뜀)`
        : `${label} / ${pageTotal} 페이지 Paddle OCR 분석 중`,
      phase === "start"
        ? "페이지 처리 시작"
        : phase === "error"
          ? "GPU 메모리 부족 등으로 이 페이지를 건너뛰었습니다"
          : `${count}개 후보`,
      {
        progressCurrent: completed,
        progressTotal: pageTotal,
        pageIndex: label,
        pageTotal,
      },
    );
  };
}

/**
 * @param {Array<{ image: unknown; output: string }>} items
 * @param {number} workerCount
 * @returns {Array<{ items: Array<{ image: unknown; output: string }>; itemIndexes: number[] }>}
 */
function chunkOcrBatchItems(items, workerCount) {
  const safeWorkerCount = Math.max(1, Math.min(items.length, workerCount));
  const chunkSize = Math.max(1, Math.ceil(items.length / safeWorkerCount));
  const chunks = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    const end = Math.min(items.length, start + chunkSize);
    chunks.push({
      items: items.slice(start, end),
      itemIndexes: Array.from(
        { length: end - start },
        (_, index) => start + index,
      ),
    });
  }
  return chunks;
}

/**
 * @param {OcrBboxOptions} [options]
 * @param {number} pageCount
 * @returns {number}
 */
function resolveOcrCpuWorkerCount(options = {}, pageCount = 1) {
  const explicit =
    readPositiveInteger(
      runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_CPU_WORKERS", options),
    ) ||
    readPositiveInteger(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_CPU_WORKERS", options),
    ) ||
    readPositiveInteger(options.ocrCpuWorkers) ||
    0;
  if (explicit > 0) {
    return Math.max(1, Math.min(pageCount, explicit));
  }
  const cpuCount = Math.max(1, os.cpus().length || 1);
  return Math.max(
    1,
    Math.min(
      pageCount,
      4,
      Math.floor(cpuCount / resolveOcrWorkerThreadCount(options)),
    ),
  );
}

/**
 * @param {OcrBboxOptions} [options]
 * @returns {number}
 */
function resolveOcrWorkerThreadCount(options = {}) {
  return (
    readPositiveInteger(
      runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_WORKER_THREADS", options),
    ) ||
    readPositiveInteger(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_WORKER_THREADS", options),
    ) ||
    readPositiveInteger(options.ocrWorkerThreads) ||
    2
  );
}

/**
 * @param {OcrBboxOptions} [options]
 * @returns {number}
 */
function resolveOcrCpuWorkerStartDelayMs(options = {}) {
  const explicit =
    readPositiveInteger(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_PADDLEOCR_CPU_WORKER_START_DELAY_MS",
        options,
      ),
    ) ||
    readPositiveInteger(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_CPU_WORKER_START_DELAY_MS",
        options,
      ),
    ) ||
    readPositiveInteger(options.ocrCpuWorkerStartDelayMs);
  return explicit || 250;
}

/**
 * @param {OcrBboxOptions} [options]
 * @param {number} chunkIndex
 * @returns {Promise<void>}
 */
async function waitForOcrCpuWorkerRamHeadroom(options = {}, chunkIndex = 0) {
  if (chunkIndex <= 0) {
    return;
  }
  const minFreeRatio = resolveOcrCpuWorkerMinFreeRamRatio(options);
  if (minFreeRatio <= 0) {
    return;
  }
  const pollMs = resolveOcrCpuWorkerRamPollMs(options);
  let reported = false;
  while (!hasOcrCpuWorkerRamHeadroom(readSystemRamInfo(), minFreeRatio)) {
    if (!reported) {
      const info = readSystemRamInfo();
      emitRuntimeProgress(
        options,
        "ocr_running",
        "Paddle OCR CPU 워커 RAM 대기 중",
        `여유 RAM ${formatPercent(info.freeRatio)} / 목표 ${formatPercent(minFreeRatio)}`,
        {
          pageIndex: null,
          pageTotal: null,
          progressMode: "log-only",
        },
      );
      reported = true;
    }
    await delayForOcrWorkerStart(pollMs, options.abortSignal);
  }
}

/**
 * @param {{ freeBytes: number; totalBytes: number; freeRatio: number }} info
 * @param {number} minFreeRatio
 * @returns {boolean}
 */
function hasOcrCpuWorkerRamHeadroom(info, minFreeRatio) {
  if (!Number.isFinite(minFreeRatio) || minFreeRatio <= 0) {
    return true;
  }
  if (!info || !Number.isFinite(info.freeRatio)) {
    return true;
  }
  return info.freeRatio >= minFreeRatio;
}

/**
 * @returns {{ freeBytes: number; totalBytes: number; freeRatio: number }}
 */
function readSystemRamInfo() {
  const freeBytes = Number(os.freemem());
  const totalBytes = Number(os.totalmem());
  const freeRatio =
    Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0
      ? freeBytes / totalBytes
      : Number.NaN;
  return { freeBytes, totalBytes, freeRatio };
}

/**
 * @param {OcrBboxOptions} [options]
 * @returns {number}
 */
function resolveOcrCpuWorkerMinFreeRamRatio(options = {}) {
  const explicit =
    readOptionalNumber(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_PADDLEOCR_CPU_WORKER_MIN_FREE_RAM_PERCENT",
        options,
      ),
    ) ??
    readOptionalNumber(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_CPU_WORKER_MIN_FREE_RAM_PERCENT",
        options,
      ),
    ) ??
    readOptionalNumber(options.ocrCpuWorkerMinFreeRamPercent);
  const percent = explicit ?? 20;
  return Math.max(0, Math.min(95, percent)) / 100;
}

/**
 * @param {OcrBboxOptions} [options]
 * @returns {number}
 */
function resolveOcrCpuWorkerRamPollMs(options = {}) {
  const explicit =
    readPositiveInteger(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_PADDLEOCR_CPU_WORKER_RAM_POLL_MS",
        options,
      ),
    ) ||
    readPositiveInteger(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_CPU_WORKER_RAM_POLL_MS",
        options,
      ),
    ) ||
    readPositiveInteger(options.ocrCpuWorkerRamPollMs);
  return explicit || 1000;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function readOptionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

/**
 * @param {string} outputPath
 * @returns {unknown}
 */
function readOcrBatchOutputPayload(outputPath) {
  if (!existsSync(outputPath)) {
    return null;
  }
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

/**
 * @param {number} delayMs
 * @param {AbortSignal | null | undefined} signal
 * @returns {Promise<void>}
 */
function delayForOcrWorkerStart(delayMs, signal) {
  if (!delayMs || delayMs <= 0) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** @returns {Error | DOMException} */
function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/**
 * @param {string} command
 * @param {OcrBboxOptions} options
 * @param {OcrRuntimeLayout | null} runtime
 * @param {OcrShellRunOptions} [runOptions]
 */
async function runOcrShellCommandWithModelRepair(
  command,
  options = {},
  runtime = null,
  runOptions = {},
) {
  try {
    return await runShellCommand(command, {
      timeoutMs: runOptions.timeoutMs,
      env: buildOcrRuntimeEnv(options, runtime),
      signal: options.abortSignal,
      onOutput: runOptions.onOutput,
    });
  } catch (error) {
    if (!isPaddleOcrModelAssetLoadFailure(error)) {
      throw error;
    }
    emitRuntimeProgress(
      options,
      "ocr_downloading",
      "Paddle OCR 모델 캐시 복구 중",
      "모델 캐시가 깨져 다시 다운로드합니다.",
      {
        progressMode: "log-only",
        installLogLine:
          "Paddle OCR 모델 로드 실패를 감지해 모델 캐시를 복구한 뒤 OCR을 다시 시도합니다.",
      },
    );
    await repairPaddleOcrModelAssetsCache(options, runtime, error);
    return await runShellCommand(command, {
      timeoutMs: runOptions.timeoutMs,
      env: buildOcrRuntimeEnv(options, runtime),
      signal: options.abortSignal,
      onOutput: runOptions.onOutput,
    });
  }
}

/**
 * @param {RuntimeOptions} [options]
 * @returns {RuntimeOptions}
 */
function withoutPageProgressOptions(options = {}) {
  const next = { ...options };
  delete next.ocrPageIndex;
  delete next.ocrPageTotal;
  delete next.ocrProgressDefaultToPage;
  delete next.pageIndex;
  delete next.pageTotal;
  return next;
}

/** @param {unknown} value */
function isTruthy(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

/**
 * @param {string} batchPath
 * @param {string} progressPath
 * @param {OcrBboxOptions} [options]
 */
async function cleanupOcrBatchControlFiles(
  batchPath,
  progressPath,
  options = {},
) {
  if (
    options.keepOcrBatchArtifacts ||
    isTruthy(
      runtimeOverrideEnv("MANGA_TRANSLATOR_KEEP_OCR_BATCH_ARTIFACTS", options),
    )
  ) {
    return;
  }
  await Promise.all([
    safeCleanup("remove OCR batch request file", () =>
      rm(batchPath, { force: true }),
    ),
    safeCleanup("remove OCR batch progress file", () =>
      rm(progressPath, { force: true }),
    ),
  ]);
}

module.exports = {
  buildCpuFallbackOcrOptions,
  canFallBackToCpuAfterGpuFailure,
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
  disableOcrGpuForSession,
  hasOcrCpuWorkerRamHeadroom,
  isOcrGpuDisabledForSession,
  readCompletedOcrBatchOutputPayload,
  resetOcrGpuSessionState,
  resolveOcrCpuWorkerCount,
  resolveOcrCpuWorkerMinFreeRamRatio,
  resolveOcrBboxProvider,
  shouldApplySessionCpuOverride,
};
