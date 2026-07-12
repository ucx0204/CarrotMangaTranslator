// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/** @typedef {RuntimeOptions & { outputDir?: string | null; imagePath?: unknown; ocrBatchCompletedBefore?: unknown; ocrBatchTotal?: unknown; ocrDeviceOverride?: unknown }} OcrBboxOptions */
/** @typedef {{ hints: unknown[]; diagnostics: unknown[]; noTextDetected: boolean; textEvidenceCount: number }} OcrBboxResult */
/** @typedef {{ image: unknown; output: string }} OcrBatchItem */
/** @typedef {{ batchOptions: OcrBboxOptions; firstOptions: OcrBboxOptions; items: OcrBatchItem[]; normalizedOptions: OcrBboxOptions[]; provider: string; runtime: OcrRuntimeLayout | null; batchPath: string; progressPath: string }} OcrBatchContext */
/** @typedef {{ handleCommandOutput: (line: string) => void; emitPageProgress: (progress: { itemIndex: number; phase: string; count: number }) => void; resolveItemIndex?: (progress: { index: number; total: number }) => number | undefined; eventKeyPrefix?: string }} ProgressHandlerOptions */
/** @typedef {Parameters<typeof createOcrBatchPipeline>[0]} Dependencies */

/**
 * @param {{
 *   path: typeof import("node:path");
 *   mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
 *   rm: (path: string, options: { force: true }) => Promise<unknown>;
 *   writeFile: (path: string, data: string, encoding: "utf8") => Promise<unknown>;
 *   collectOcrBboxHints: (options: OcrBboxOptions) => Promise<OcrBboxResult>;
 *   applyBatchSessionCpuOverride: (options: OcrBboxOptions[]) => OcrBboxOptions[];
 *   resolveOcrBboxProvider: (options?: OcrBboxOptions) => string;
 *   withoutPageProgressOptions: (options?: OcrBboxOptions) => OcrBboxOptions;
 *   ensurePaddleOcrRuntime: (options: OcrBboxOptions) => Promise<OcrRuntimeLayout>;
 *   resolveOcrCpuWorkerCount: (options?: OcrBboxOptions, pageCount?: number) => number;
 *   isExplicitCpuOcrDevice: (options?: OcrBboxOptions) => boolean;
 *   resolveOcrDevice: (options?: OcrBboxOptions) => string;
 *   collectOcrBboxHintsBatchInCpuWorkers: (context: OcrBatchContext & { workerCount: number }) => Promise<OcrBboxResult[]>;
 *   buildOcrBboxBatchCommand: (options: OcrBboxOptions, batchPath: string, runtime: OcrRuntimeLayout | null, progressPath: string) => string;
 *   emitRuntimeProgress: (options: object | undefined, phase: string, progressText: string, detail?: string, progress?: Record<string, unknown>) => void;
 *   resolveOcrDeviceLabel: (options?: OcrBboxOptions) => string;
 *   readPositiveInteger: (value: unknown) => number | null;
 *   createOcrCommandProgressHandler: (options: OcrBboxOptions, context: Record<string, unknown>) => (line: string) => void;
 *   createOcrBatchProgressEmitter: (batchOptions: OcrBboxOptions, firstOptions: OcrBboxOptions, normalizedOptions: OcrBboxOptions[]) => (progress: { itemIndex: number; phase: string; count: number }) => void;
 *   createProgressLineHandler: (options: ProgressHandlerOptions) => (line: string) => void;
 *   createOcrBatchProgressFilePoller: (path: string, handler: (line: string) => void) => { start: () => void; stop: () => void };
 *   runOcrShellCommandWithModelRepair: (command: string, options: OcrBboxOptions, runtime: OcrRuntimeLayout | null, runOptions: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
 *   resolveOcrBboxTimeoutMs: (count: number) => number;
 *   cleanupOcrBatchControlFiles: (batchPath: string, progressPath: string, options?: OcrBboxOptions) => Promise<unknown>;
 *   readOcrBatchOutputPayload: (path: string) => unknown;
 *   readCompletedOcrBatchOutputPayload: (path: string) => unknown;
 *   normalizeOcrBboxHintPayload: (payload: unknown, options?: OcrBboxOptions) => unknown[];
 *   buildOcrBboxResult: (hints?: unknown[], diagnostics?: unknown[], options?: Record<string, unknown>) => OcrBboxResult;
 *   createDetailedError: (message: string, details: Record<string, unknown>) => Error;
 *   truncateText: (value: unknown, limit: number) => string;
 *   isOcrGpuRequested: (options?: OcrBboxOptions) => boolean;
 *   resolveEffectiveOcrDevice: (options?: OcrBboxOptions) => string;
 *   canFallBackToCpuAfterGpuFailure: (options: OcrBboxOptions, error: unknown) => boolean;
 *   buildPaddleOcrGpuFailureMessage: (error: unknown, options?: OcrBboxOptions) => string;
 *   disableOcrGpuForSession: (reason: unknown) => void;
 *   buildCpuFallbackOcrOptions: (options: OcrBboxOptions) => OcrBboxOptions;
 *   recoverOcrBatchWithCpuFallback: (context: OcrBatchContext, error: unknown, collectBatch: (options: OcrBboxOptions[]) => Promise<OcrBboxResult[]>) => Promise<OcrBboxResult[] | null>;
 * }} dependencies
 */
function createOcrBatchPipeline(dependencies) {
  return {
    collectOcrBboxHintsBatch: collectOcrBboxHintsBatch.bind(null, dependencies),
  };
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions[]} [pageOptionsList] @returns {Promise<OcrBboxResult[]>} */
async function collectOcrBboxHintsBatch(dependencies, pageOptionsList = []) {
  const validOptions = pageOptionsList.filter(Boolean);
  if (validOptions.length === 0) {
    return [];
  }
  const normalizedOptions =
    dependencies.applyBatchSessionCpuOverride(validOptions);
  const firstOptions = normalizedOptions[0] || {};
  const provider = dependencies.resolveOcrBboxProvider(firstOptions);
  if (provider !== "paddleocr-vl") {
    return await collectSequentially(dependencies, normalizedOptions);
  }
  const batchOptions = dependencies.withoutPageProgressOptions(firstOptions);
  const runtime = await dependencies.ensurePaddleOcrRuntime(batchOptions);
  const context = await prepareBatchContext(dependencies, {
    batchOptions,
    firstOptions,
    normalizedOptions,
    provider,
    runtime,
  });
  const workerCount = dependencies.resolveOcrCpuWorkerCount(
    batchOptions,
    normalizedOptions.length,
  );
  if (shouldUseCpuWorkers(dependencies, batchOptions, workerCount)) {
    return await dependencies.collectOcrBboxHintsBatchInCpuWorkers({
      ...context,
      workerCount,
    });
  }
  return await runSingleProcessBatch(dependencies, context);
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions[]} optionsList */
async function collectSequentially(dependencies, optionsList) {
  const results = [];
  for (const options of optionsList) {
    results.push(await dependencies.collectOcrBboxHints(options));
  }
  return results;
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {number} workerCount */
function shouldUseCpuWorkers(dependencies, options, workerCount) {
  return (
    dependencies.isExplicitCpuOcrDevice(options) &&
    dependencies.resolveOcrDevice(options) === "cpu" &&
    workerCount > 1
  );
}

/** @param {Dependencies} dependencies @param {Omit<OcrBatchContext, "items" | "batchPath" | "progressPath">} base */
async function prepareBatchContext(dependencies, base) {
  const root = base.firstOptions.outputDir || process.cwd();
  const suffix = `${Date.now()}-${process.pid}`;
  const batchPath = dependencies.path.join(root, `ocr-batch-${suffix}.json`);
  const progressPath = dependencies.path.join(
    root,
    `ocr-batch-progress-${suffix}.jsonl`,
  );
  const items = base.normalizedOptions.map((options, index) =>
    buildBatchItem(dependencies, options, base.firstOptions, index),
  );
  await dependencies.mkdir(dependencies.path.dirname(batchPath), {
    recursive: true,
  });
  for (const item of items) {
    await dependencies.mkdir(dependencies.path.dirname(item.output), {
      recursive: true,
    });
  }
  for (const item of items) {
    await dependencies.rm(item.output, { force: true });
  }
  return { ...base, items, batchPath, progressPath };
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {OcrBboxOptions} firstOptions @param {number} index */
function buildBatchItem(dependencies, options, firstOptions, index) {
  const outputDir =
    options.outputDir ||
    dependencies.path.join(
      firstOptions.outputDir || process.cwd(),
      `page-${index + 1}`,
    );
  return {
    image: options.imagePath,
    output: dependencies.path.join(outputDir, "ocr-bbox-hints.json"),
  };
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context */
async function runSingleProcessBatch(dependencies, context) {
  await writeBatchControlFiles(dependencies, context);
  const command = dependencies.buildOcrBboxBatchCommand(
    context.batchOptions,
    context.batchPath,
    context.runtime,
    context.progressPath,
  );
  emitBatchStarted(dependencies, context);
  const handleProgressLine = buildBatchProgressHandler(dependencies, context);
  const poller = dependencies.createOcrBatchProgressFilePoller(
    context.progressPath,
    handleProgressLine,
  );
  try {
    poller.start();
    const output = await dependencies.runOcrShellCommandWithModelRepair(
      command,
      context.batchOptions,
      context.runtime,
      {
        timeoutMs: dependencies.resolveOcrBboxTimeoutMs(context.items.length),
        onOutput: handleProgressLine,
      },
    );
    return buildBatchResults(dependencies, context, command, output);
  } catch (error) {
    poller.stop();
    const recovered = await dependencies.recoverOcrBatchWithCpuFallback(
      context,
      error,
      (options) => collectOcrBboxHintsBatch(dependencies, options),
    );
    if (recovered) {
      return recovered;
    }
    throw error;
  } finally {
    poller.stop();
    await dependencies.cleanupOcrBatchControlFiles(
      context.batchPath,
      context.progressPath,
      context.batchOptions,
    );
  }
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context */
async function writeBatchControlFiles(dependencies, context) {
  await dependencies.writeFile(
    context.batchPath,
    `${JSON.stringify({ items: context.items }, null, 2)}\n`,
    "utf8",
  );
  await dependencies.writeFile(context.progressPath, "", "utf8");
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context */
function emitBatchStarted(dependencies, context) {
  dependencies.emitRuntimeProgress(
    context.batchOptions,
    "ocr_running",
    "Paddle OCR 배치 위치 분석 중",
    `${context.items.length}페이지, 장치: ${dependencies.resolveOcrDeviceLabel(context.batchOptions)}`,
    {
      pageIndex: null,
      pageTotal: null,
      progressCurrent:
        dependencies.readPositiveInteger(
          context.firstOptions.ocrBatchCompletedBefore,
        ) || 0,
      progressTotal:
        dependencies.readPositiveInteger(context.firstOptions.ocrBatchTotal) ||
        context.items.length,
    },
  );
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context */
function buildBatchProgressHandler(dependencies, context) {
  const handleCommandOutput = dependencies.createOcrCommandProgressHandler(
    context.batchOptions,
    {
      progressText: "Paddle OCR 배치 위치 분석 중",
      progressCurrent:
        dependencies.readPositiveInteger(
          context.firstOptions.ocrBatchCompletedBefore,
        ) || 0,
      progressTotal:
        dependencies.readPositiveInteger(context.firstOptions.ocrBatchTotal) ||
        context.items.length,
    },
  );
  return dependencies.createProgressLineHandler({
    handleCommandOutput,
    emitPageProgress: dependencies.createOcrBatchProgressEmitter(
      context.batchOptions,
      context.firstOptions,
      context.normalizedOptions,
    ),
  });
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context @param {string} command @param {{ stdout: string; stderr: string }} output */
function buildBatchResults(dependencies, context, command, output) {
  const cpuFallbackRun =
    String(context.batchOptions.ocrDeviceOverride ?? "")
      .trim()
      .toLowerCase() === "cpu";
  return context.normalizedOptions.map((options, index) =>
    buildBatchPageResult(
      dependencies,
      context,
      command,
      output,
      options,
      index,
      cpuFallbackRun,
    ),
  );
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context @param {string} command @param {{ stdout: string; stderr: string }} output @param {OcrBboxOptions} options @param {number} index @param {boolean} cpuFallbackRun */
function buildBatchPageResult(
  dependencies,
  context,
  command,
  output,
  options,
  index,
  cpuFallbackRun,
) {
  const outputPath = context.items[index].output;
  const payload = dependencies.readOcrBatchOutputPayload(outputPath);
  if (!payload) {
    return handleMissingPageOutput(
      dependencies,
      command,
      outputPath,
      output,
      context.provider,
      cpuFallbackRun,
    );
  }
  const hints = dependencies.normalizeOcrBboxHintPayload(payload, options);
  return dependencies.buildOcrBboxResult(hints, [
    buildBatchDiagnostic(
      dependencies,
      context,
      command,
      outputPath,
      output,
      hints.length,
    ),
  ]);
}

/** @param {Dependencies} dependencies @param {string} command @param {string} outputPath @param {{ stdout: string; stderr: string }} output @param {string} provider @param {boolean} cpuFallbackRun */
function handleMissingPageOutput(
  dependencies,
  command,
  outputPath,
  output,
  provider,
  cpuFallbackRun,
) {
  if (cpuFallbackRun) {
    const message = output.stderr.trim() || output.stdout.trim();
    return dependencies.buildOcrBboxResult(
      [],
      [
        {
          provider,
          reason: "page-ocr-failed",
          message: dependencies.truncateText(message, 800),
          outputPath,
        },
      ],
      { noTextDetected: false },
    );
  }
  throw dependencies.createDetailedError(
    "OCR bbox batch command did not produce JSON.",
    {
      command,
      outputPath,
      stdoutPreview: dependencies.truncateText(output.stdout, 2000),
      stderrPreview: dependencies.truncateText(output.stderr, 2000),
    },
  );
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context @param {string} command @param {string} outputPath @param {{ stdout: string; stderr: string }} output @param {number} hintCount */
function buildBatchDiagnostic(
  dependencies,
  context,
  command,
  outputPath,
  output,
  hintCount,
) {
  return {
    provider: context.provider,
    command,
    outputPath,
    runtimeDir: context.runtime?.runtimeDir || null,
    runtimeVariant: context.runtime?.runtimeVariant || null,
    packageDir: context.runtime?.packageDir || null,
    pythonPath: context.runtime?.pythonPath || null,
    runtimePrepared: Boolean(context.runtime?.prepared),
    hintCount,
    stdoutPreview: dependencies.truncateText(output.stdout.trim(), 1200),
    stderrPreview: dependencies.truncateText(output.stderr.trim(), 1200),
    runtimeDiagnostics: context.runtime?.diagnostics || [],
  };
}

module.exports = { createOcrBatchPipeline };
