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
  resolveOcrDevice,
  resolveOcrDeviceLabel,
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

  try {
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
  } catch (error) {
    const diagnostic = buildOcrBboxDiagnostic(provider, error);
    diagnostics.push(diagnostic);
    if (provider === "paddleocr-vl" && isOcrGpuRequested(options)) {
      const failureMessage = buildPaddleOcrGpuFailureMessage(error, options);
      emitRuntimeProgress(
        options,
        "ocr_running",
        "Paddle OCR GPU 실행 실패",
        failureMessage,
      );
      throw createOcrRuntimeError(failureMessage, { diagnostics }, error);
    }
    return buildOcrBboxResult([], diagnostics, { noTextDetected: false });
  }
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
  const normalizedOptions = pageOptionsList.filter(Boolean);
  if (normalizedOptions.length === 0) {
    return [];
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
    const pageOptions = normalizedOptions[progress.index - 1] || firstOptions;
    const completedBefore =
      readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0;
    const batchTotal =
      readPositiveInteger(firstOptions.ocrBatchTotal) || progress.total;
    const pageIndex =
      readPositiveInteger(pageOptions.ocrPageIndex) ||
      completedBefore + progress.index;
    const pageTotal =
      readPositiveInteger(pageOptions.ocrPageTotal) || batchTotal;
    const completedCount =
      phase === "start"
        ? Math.max(0, completedBefore + progress.index - 1)
        : completedBefore + progress.index;
    emitRuntimeProgress(
      batchOptions,
      "ocr_running",
      `${pageIndex} / ${pageTotal} 페이지 Paddle OCR 분석 중`,
      phase === "start" ? "페이지 처리 시작" : `${progress.count}개 후보`,
      {
        progressCurrent: Math.min(pageTotal, completedCount),
        progressTotal: pageTotal,
        pageIndex,
        pageTotal,
      },
    );
  };
  const progressPoller = createOcrBatchProgressFilePoller(
    progressPath,
    handleProgressLine,
  );
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
  } finally {
    progressPoller.stop();
    await cleanupOcrBatchControlFiles(batchPath, progressPath, batchOptions);
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

  const workerStartDelayMs = resolveOcrCpuWorkerStartDelayMs(batchOptions);
  const chunkRuns = await Promise.all(
    chunks.map(async (chunk, chunkIndex) => {
      await delayForOcrWorkerStart(
        chunkIndex * workerStartDelayMs,
        batchOptions.abortSignal,
      );
      return await runOcrBboxBatchChunk({
        batchOptions,
        chunk,
        chunkIndex,
        firstOptions,
        normalizedOptions,
        runtime,
      });
    }),
  );
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
 *   firstOptions: OcrBboxOptions;
 *   normalizedOptions: OcrBboxOptions[];
 *   runtime: OcrRuntimeLayout | null;
 * }} params
 * @returns {Promise<{ command: string; itemIndexes: number[]; stdout: string; stderr: string }>}
 */
async function runOcrBboxBatchChunk({
  batchOptions,
  chunk,
  chunkIndex,
  firstOptions,
  normalizedOptions,
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
    emitOcrBatchPageProgress({
      batchOptions,
      firstOptions,
      normalizedOptions,
      itemIndex,
      phase,
      count: Number(progress.count) || 0,
    });
  };
  const progressPoller = createOcrBatchProgressFilePoller(
    progressPath,
    handleProgressLine,
  );
  let stdout = "";
  let stderr = "";
  try {
    progressPoller.start();
    ({ stdout, stderr } = await runOcrShellCommandWithModelRepair(
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
    ));
    return { command, itemIndexes: chunk.itemIndexes, stdout, stderr };
  } finally {
    progressPoller.stop();
    await cleanupOcrBatchControlFiles(batchPath, progressPath, batchOptions);
  }
}

/**
 * @param {{
 *   batchOptions: OcrBboxOptions;
 *   firstOptions: OcrBboxOptions;
 *   normalizedOptions: OcrBboxOptions[];
 *   itemIndex: number;
 *   phase: string;
 *   count: number;
 * }} params
 * @returns {void}
 */
function emitOcrBatchPageProgress({
  batchOptions,
  firstOptions,
  normalizedOptions,
  itemIndex,
  phase,
  count,
}) {
  const pageOptions = normalizedOptions[itemIndex] || firstOptions;
  const completedBefore =
    readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0;
  const batchTotal =
    readPositiveInteger(firstOptions.ocrBatchTotal) || normalizedOptions.length;
  const pageIndex =
    readPositiveInteger(pageOptions.ocrPageIndex) ||
    completedBefore + itemIndex + 1;
  const pageTotal = readPositiveInteger(pageOptions.ocrPageTotal) || batchTotal;
  const completedCount =
    phase === "start"
      ? Math.max(0, completedBefore + itemIndex)
      : completedBefore + itemIndex + 1;
  emitRuntimeProgress(
    batchOptions,
    "ocr_running",
    `${pageIndex} / ${pageTotal} 페이지 Paddle OCR 분석 중`,
    phase === "start" ? "페이지 처리 시작" : `${count}개 후보`,
    {
      progressCurrent: Math.min(pageTotal, completedCount),
      progressTotal: pageTotal,
      pageIndex,
      pageTotal,
    },
  );
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
    readPositiveInteger(options.ocrCpuWorkers);
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
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
  resolveOcrCpuWorkerCount,
  resolveOcrBboxProvider,
};
