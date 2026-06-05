const { existsSync, readFileSync } = require("node:fs");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");

const {
  extractJsonText,
  normalizeOcrBboxHintPayload
} = require("./simple-page-ocr-hints.cjs");
const {
  createOcrBatchProgressFilePoller,
  parseOcrBatchProgressLine,
  resolveOcrBboxTimeoutMs
} = require("./simple-page-progress.cjs");
const {
  readOcrCandidateText,
  readPositiveInteger
} = require("./simple-page-prompts.cjs");
const {
  runtimeOverrideEnv
} = require("./simple-page-child-env.cjs");
const {
  buildOcrRuntimeEnv,
  buildPaddleOcrGpuFailureMessage,
  isOcrGpuRequested,
  resolveOcrDeviceLabel,
  summarizeOcrErrorMessage
} = require("./simple-page-ocr-runtime-config.cjs");
const {
  createOcrCommandProgressHandler
} = require("./simple-page-ocr-progress-handlers.cjs");
const {
  buildOcrBboxBatchCommand,
  buildOcrBboxCommand
} = require("./simple-page-ocr-commands.cjs");
const {
  createOcrRuntimeError,
  ensurePaddleOcrRuntime
} = require("./simple-page-ocr-runtime-manager.cjs");
const {
  createDetailedError,
  emitRuntimeProgress,
  truncateText
} = require("./simple-page-runtime-common.cjs");
const {
  runShellCommand
} = require("./simple-page-shell-utils.cjs");

function resolveOcrBboxProvider(options = {}) {
  const explicit = String(options.ocrBboxProvider ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_PROVIDER", options) ?? "").trim();
  if (explicit) {
    return explicit;
  }
  if (isTruthy(runtimeOverrideEnv("MANGA_TRANSLATOR_DISABLE_OCR_BBOX", options))) {
    return "none";
  }
  if (isTruthy(runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_VL", options))) {
    return "paddleocr-vl";
  }
  if (String(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_CMD", options) ?? "").trim()) {
    return "external-command";
  }
  if (String(runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH", options) ?? "").trim()) {
    return "json-file";
  }
  return "paddleocr-vl";
}

async function collectOcrBboxHints(options = {}) {
  const diagnostics = [];
  if (options.skipOcrBboxHints) {
    return buildOcrBboxResult([], [{ provider: "disabled", reason: "skipOcrBboxHints" }], { noTextDetected: false });
  }

  const inlineHints = normalizeOcrBboxHintPayload(options.ocrBboxHints, options);
  if (Object.prototype.hasOwnProperty.call(options, "ocrBboxHints")) {
    return buildOcrBboxResult(inlineHints, [{
        provider: "inline",
        hintCount: inlineHints.length
      }]);
  }

  const hintsPath = String(options.ocrBboxHintsPath ?? runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_HINTS_PATH", options) ?? "").trim();
  if (hintsPath) {
    try {
      const rawText = await readFile(hintsPath, "utf8");
      const hints = normalizeOcrBboxHintPayload(JSON.parse(rawText), options);
      return buildOcrBboxResult(hints, [{ provider: "json-file", path: hintsPath }]);
    } catch (error) {
      diagnostics.push(buildOcrBboxDiagnostic("json-file", error, { path: hintsPath }));
    }
  }

  const provider = resolveOcrBboxProvider(options);
  if (provider === "none" || provider === "json-file") {
    return buildOcrBboxResult([], diagnostics, { noTextDetected: false });
  }

  try {
    emitRuntimeProgress(options, "ocr_preparing", "Paddle OCR 준비 중", `장치: ${resolveOcrDeviceLabel(options)}`);
    const commandResult = await runOcrBboxCommand(options, provider);
    const hints = normalizeOcrBboxHintPayload(commandResult.payload, options);
    const result = buildOcrBboxResult(hints, [{
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
        runtimeDiagnostics: commandResult.runtimeDiagnostics || []
      }]);
    emitRuntimeProgress(
      options,
      "ocr_running",
      result.noTextDetected ? "Paddle OCR 텍스트 없음" : `Paddle OCR 후보 ${hints.length}개 감지`,
      result.noTextDetected ? `장치: ${resolveOcrDeviceLabel(options)}, 텍스트 근거 없음` : `장치: ${resolveOcrDeviceLabel(options)}`
    );
    return result;
  } catch (error) {
    const diagnostic = buildOcrBboxDiagnostic(provider, error);
    diagnostics.push(diagnostic);
    if (provider === "paddleocr-vl" && isOcrGpuRequested(options)) {
      const failureMessage = buildPaddleOcrGpuFailureMessage(error, options);
      emitRuntimeProgress(options, "ocr_running", "Paddle OCR GPU 실행 실패", failureMessage);
      throw createOcrRuntimeError(
        failureMessage,
        { diagnostics },
        error
      );
    }
    return buildOcrBboxResult([], diagnostics, { noTextDetected: false });
  }
}

function buildOcrBboxResult(hints = [], diagnostics = [], options = {}) {
  const normalizedHints = Array.isArray(hints) ? hints : [];
  const textEvidenceCount = countOcrTextEvidence(normalizedHints);
  const noTextDetected =
    typeof options.noTextDetected === "boolean"
      ? options.noTextDetected
      : normalizedHints.length === 0;
  return {
    hints: normalizedHints,
    diagnostics: Array.isArray(diagnostics) ? diagnostics : [],
    noTextDetected,
    textEvidenceCount
  };
}

function countOcrTextEvidence(hints = []) {
  return hints.reduce((count, hint) => count + (hasJapaneseTextEvidence(readOcrCandidateText(hint)) ? 1 : 0), 0);
}

function hasJapaneseTextEvidence(value) {
  const text = String(value ?? "");
  for (const char of text) {
    const code = char.codePointAt(0);
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

function buildOcrBboxDiagnostic(provider, error, extra = {}) {
  return {
    provider,
    reason: "ocr-bbox-unavailable",
    message: summarizeOcrErrorMessage(error),
    ...extra
  };
}

async function runOcrBboxCommand(options = {}, provider = "external-command") {
  await mkdir(options.outputDir, { recursive: true });
  const outputPath = path.join(options.outputDir, "ocr-bbox-hints.json");
  const runtime = provider === "paddleocr-vl" ? await ensurePaddleOcrRuntime(options) : null;
  const command = buildOcrBboxCommand(options, provider, outputPath, runtime);
  emitRuntimeProgress(options, "ocr_running", "Paddle OCR 모델 다운로드/위치 분석 중", `장치: ${resolveOcrDeviceLabel(options)}`);
  const handleOcrOutput = createOcrCommandProgressHandler(options, {
    progressText: "Paddle OCR 모델 다운로드/위치 분석 중"
  });
  const { stdout, stderr } = await runShellCommand(command, {
    timeoutMs: resolveOcrBboxTimeoutMs(1),
    env: buildOcrRuntimeEnv(options, runtime),
    signal: options.abortSignal,
    onOutput: handleOcrOutput
  });

  let rawText = "";
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
      stderrPreview: truncateText(stderr, 2000)
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
    payload: JSON.parse(rawText)
  };
}

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
  const batchPath = path.join(firstOptions.outputDir || process.cwd(), `ocr-batch-${Date.now()}-${process.pid}.json`);
  const progressPath = path.join(firstOptions.outputDir || process.cwd(), `ocr-batch-progress-${Date.now()}-${process.pid}.jsonl`);
  const items = normalizedOptions.map((options, index) => {
    const outputDir = options.outputDir || path.join(firstOptions.outputDir || process.cwd(), `page-${index + 1}`);
    return {
      image: options.imagePath,
      output: path.join(outputDir, "ocr-bbox-hints.json")
    };
  });
  await mkdir(path.dirname(batchPath), { recursive: true });
  for (const item of items) {
    await mkdir(path.dirname(item.output), { recursive: true });
  }
  await writeFile(batchPath, `${JSON.stringify({ items }, null, 2)}\n`, "utf8");
  await writeFile(progressPath, "", "utf8");

  const command = buildOcrBboxBatchCommand(batchOptions, batchPath, runtime, progressPath);
  emitRuntimeProgress(batchOptions, "ocr_running", "Paddle OCR 배치 위치 분석 중", `${items.length}페이지, 장치: ${resolveOcrDeviceLabel(batchOptions)}`, {
    pageIndex: null,
    pageTotal: null,
    progressCurrent: readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0,
    progressTotal: readPositiveInteger(firstOptions.ocrBatchTotal) || items.length
  });
  const seenProgressEvents = new Set();
  const handleCommandOutput = createOcrCommandProgressHandler(batchOptions, {
    progressText: "Paddle OCR 배치 위치 분석 중",
    progressCurrent: readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0,
    progressTotal: readPositiveInteger(firstOptions.ocrBatchTotal) || items.length
  });
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
      const completedBefore = readPositiveInteger(firstOptions.ocrBatchCompletedBefore) || 0;
      const batchTotal = readPositiveInteger(firstOptions.ocrBatchTotal) || progress.total;
      const pageIndex = readPositiveInteger(pageOptions.ocrPageIndex) || completedBefore + progress.index;
      const pageTotal = readPositiveInteger(pageOptions.ocrPageTotal) || batchTotal;
      const completedCount = phase === "start"
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
          pageTotal
        }
      );
  };
  const progressPoller = createOcrBatchProgressFilePoller(progressPath, handleProgressLine);
  let stdout = "";
  let stderr = "";
  try {
    progressPoller.start();
    ({ stdout, stderr } = await runShellCommand(command, {
      timeoutMs: resolveOcrBboxTimeoutMs(items.length),
      env: buildOcrRuntimeEnv(batchOptions, runtime),
      signal: batchOptions.abortSignal,
      onOutput: handleProgressLine
    }));
  } finally {
    progressPoller.stop();
  }

  return normalizedOptions.map((options, index) => {
    const outputPath = items[index].output;
    let payload = null;
    if (existsSync(outputPath)) {
      payload = JSON.parse(readFileSync(outputPath, "utf8"));
    }
    if (!payload) {
      throw createDetailedError("OCR bbox batch command did not produce JSON.", {
        command,
        outputPath,
        stdoutPreview: truncateText(stdout, 2000),
        stderrPreview: truncateText(stderr, 2000)
      });
    }
    const hints = normalizeOcrBboxHintPayload(payload, options);
    return buildOcrBboxResult(hints, [{
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
        runtimeDiagnostics: runtime?.diagnostics || []
      }]);
  });
}

function withoutPageProgressOptions(options = {}) {
  const next = { ...options };
  delete next.ocrPageIndex;
  delete next.ocrPageTotal;
  delete next.ocrProgressDefaultToPage;
  delete next.pageIndex;
  delete next.pageTotal;
  return next;
}

function isTruthy(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

module.exports = {
  collectOcrBboxHints,
  collectOcrBboxHintsBatch,
  resolveOcrBboxProvider
};
