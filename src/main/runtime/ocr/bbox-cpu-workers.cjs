// @ts-check
/** @typedef {import("../runtime-jsdoc-types").CommandSpec} CommandSpec */
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/** @typedef {RuntimeOptions & { outputDir?: string | null; ocrBatchCompletedBefore?: unknown; ocrBatchTotal?: unknown; ocrWorkerThreads?: unknown }} OcrBboxOptions */
/** @typedef {{ hints: unknown[]; diagnostics: unknown[]; noTextDetected: boolean; textEvidenceCount: number }} OcrBboxResult */
/** @typedef {{ items: Array<{ image: unknown; output: string }>; itemIndexes: number[] }} OcrBatchChunk */
/** @typedef {{ command: string; itemIndexes: number[]; stdout: string; stderr: string }} OcrChunkRun */
/** @typedef {{ batchOptions: OcrBboxOptions; firstOptions: OcrBboxOptions; items: Array<{ image: unknown; output: string }>; normalizedOptions: OcrBboxOptions[]; provider: string; runtime: OcrRuntimeLayout | null; workerCount: number }} OcrCpuWorkerContext */
/** @typedef {{ handleCommandOutput: (line: string) => void; emitPageProgress: (progress: { itemIndex: number; phase: string; count: number }) => void; resolveItemIndex?: (progress: { index: number; total: number }) => number | undefined; eventKeyPrefix?: string }} ProgressHandlerOptions */

/**
 * @param {{
 *   path: typeof import("node:path");
 *   mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
 *   writeFile: (path: string, data: string, encoding: "utf8") => Promise<unknown>;
 *   emitRuntimeProgress: (options: object | undefined, phase: string, progressText: string, detail?: string, progress?: Record<string, unknown>) => void;
 *   readPositiveInteger: (value: unknown) => number | null;
 *   resolveOcrWorkerThreadCount: (options?: OcrBboxOptions) => number;
 *   resolveOcrCpuWorkerStartDelayMs: (options?: OcrBboxOptions) => number;
 *   waitForOcrCpuWorkerRamHeadroom: (options?: OcrBboxOptions, chunkIndex?: number) => Promise<void>;
 *   delayForOcrWorkerStart: (delayMs: number, signal?: AbortSignal | null) => Promise<void>;
 *   createOcrBatchProgressEmitter: (batchOptions: OcrBboxOptions, firstOptions: OcrBboxOptions, normalizedOptions: OcrBboxOptions[]) => (progress: { itemIndex: number; phase: string; count: number }) => void;
 *   createProgressLineHandler: (options: ProgressHandlerOptions) => (line: string) => void;
 *   createOcrCommandProgressHandler: (options: OcrBboxOptions, context: Record<string, unknown>) => (line: string) => void;
 *   createOcrBatchProgressFilePoller: (path: string, handler: (line: string) => void) => { start: () => void; stop: () => void };
 *   buildOcrBboxBatchCommand: (options: OcrBboxOptions, batchPath: string, runtime: OcrRuntimeLayout | null, progressPath: string) => CommandSpec;
 *   formatCommandForLog: (command: CommandSpec) => string;
 *   runOcrCommandWithModelRepair: (command: CommandSpec, options: OcrBboxOptions, runtime: OcrRuntimeLayout | null, runOptions: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>;
 *   resolveOcrBboxTimeoutMs: (count: number) => number;
 *   cleanupOcrBatchControlFiles: (batchPath: string, progressPath: string, options?: OcrBboxOptions) => Promise<unknown>;
 *   readOcrBatchOutputPayload: (path: string) => unknown;
 *   normalizeOcrBboxHintPayload: (payload: unknown, options?: OcrBboxOptions) => unknown[];
 *   buildOcrBboxResult: (hints?: unknown[], diagnostics?: unknown[], options?: Record<string, unknown>) => OcrBboxResult;
 *   createDetailedError: (message: string, details: Record<string, unknown>) => Error;
 *   truncateText: (value: unknown, limit: number) => string;
 * }} dependencies
 */
function createOcrCpuWorkers(dependencies) {
  return {
    collectOcrBboxHintsBatchInCpuWorkers:
      collectOcrBboxHintsBatchInCpuWorkers.bind(null, dependencies),
  };
}

/**
 * @param {Parameters<typeof createOcrCpuWorkers>[0]} dependencies
 * @param {OcrCpuWorkerContext} context
 * @returns {Promise<OcrBboxResult[]>}
 */
async function collectOcrBboxHintsBatchInCpuWorkers(dependencies, context) {
  const chunks = chunkOcrBatchItems(context.items, context.workerCount);
  emitCpuWorkerBatchStarted(dependencies, context, chunks.length);
  const emitPageProgress = dependencies.createOcrBatchProgressEmitter(
    context.batchOptions,
    context.firstOptions,
    context.normalizedOptions,
  );
  const runs = await runChunksWithStagger(
    dependencies,
    context,
    chunks,
    emitPageProgress,
  );
  const runByItemIndex = indexRunsByItem(runs);
  return context.normalizedOptions.map((options, index) =>
    buildWorkerPageResult(
      dependencies,
      context,
      runByItemIndex,
      options,
      index,
    ),
  );
}

/** @param {Parameters<typeof createOcrCpuWorkers>[0]} dependencies @param {OcrCpuWorkerContext} context @param {number} chunkCount */
function emitCpuWorkerBatchStarted(dependencies, context, chunkCount) {
  const threads = dependencies.resolveOcrWorkerThreadCount(
    context.batchOptions,
  );
  dependencies.emitRuntimeProgress(
    context.batchOptions,
    "ocr_running",
    "Paddle OCR CPU 병렬 배치 위치 분석 중",
    `${context.items.length}페이지, ${chunkCount}워커, 워커당 ${threads}스레드`,
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

/**
 * @param {Parameters<typeof createOcrCpuWorkers>[0]} dependencies
 * @param {OcrCpuWorkerContext} context
 * @param {OcrBatchChunk[]} chunks
 * @param {(progress: { itemIndex: number; phase: string; count: number }) => void} emitPageProgress
 */
async function runChunksWithStagger(
  dependencies,
  context,
  chunks,
  emitPageProgress,
) {
  const delayMs = dependencies.resolveOcrCpuWorkerStartDelayMs(
    context.batchOptions,
  );
  /** @type {Array<Promise<OcrChunkRun>>} */
  const promises = [];
  for (const [chunkIndex, chunk] of chunks.entries()) {
    if (chunkIndex > 0) {
      await dependencies.delayForOcrWorkerStart(
        delayMs,
        context.batchOptions.abortSignal,
      );
    }
    await dependencies.waitForOcrCpuWorkerRamHeadroom(
      context.batchOptions,
      chunkIndex,
    );
    const promise = runOcrBboxBatchChunk(dependencies, {
      ...context,
      chunk,
      chunkIndex,
      emitPageProgress,
    });
    promise.catch(() => {
      // error-policy-allow: Promise.all observes this rejection after staggered worker starts.
    });
    promises.push(promise);
  }
  return await Promise.all(promises);
}

/** @param {OcrChunkRun[]} runs */
function indexRunsByItem(runs) {
  const index = new Map();
  for (const run of runs) {
    for (const itemIndex of run.itemIndexes) {
      index.set(itemIndex, run);
    }
  }
  return index;
}

/**
 * @param {Parameters<typeof createOcrCpuWorkers>[0]} dependencies
 * @param {OcrCpuWorkerContext} context
 * @param {Map<number, OcrChunkRun>} runByItemIndex
 * @param {OcrBboxOptions} options
 * @param {number} index
 */
function buildWorkerPageResult(
  dependencies,
  context,
  runByItemIndex,
  options,
  index,
) {
  const outputPath = context.items[index].output;
  const payload = dependencies.readOcrBatchOutputPayload(outputPath);
  const run = runByItemIndex.get(index) || emptyChunkRun();
  if (!payload) {
    throwMissingOutput(dependencies, run, outputPath);
  }
  const hints = dependencies.normalizeOcrBboxHintPayload(payload, options);
  return dependencies.buildOcrBboxResult(hints, [
    buildWorkerDiagnostic(dependencies, context, run, outputPath, hints.length),
  ]);
}

/** @param {Parameters<typeof createOcrCpuWorkers>[0]} dependencies @param {OcrChunkRun} run @param {string} outputPath */
function throwMissingOutput(dependencies, run, outputPath) {
  throw dependencies.createDetailedError(
    "OCR bbox batch command did not produce JSON.",
    {
      command: run.command,
      outputPath,
      stdoutPreview: dependencies.truncateText(run.stdout, 2000),
      stderrPreview: dependencies.truncateText(run.stderr, 2000),
    },
  );
}

/** @param {Parameters<typeof createOcrCpuWorkers>[0]} dependencies @param {OcrCpuWorkerContext} context @param {OcrChunkRun} run @param {string} outputPath @param {number} hintCount */
function buildWorkerDiagnostic(
  dependencies,
  context,
  run,
  outputPath,
  hintCount,
) {
  return {
    provider: context.provider,
    command: run.command,
    outputPath,
    runtimeDir: context.runtime?.runtimeDir || null,
    runtimeVariant: context.runtime?.runtimeVariant || null,
    packageDir: context.runtime?.packageDir || null,
    pythonPath: context.runtime?.pythonPath || null,
    runtimePrepared: Boolean(context.runtime?.prepared),
    hintCount,
    stdoutPreview: dependencies.truncateText(run.stdout.trim(), 1200),
    stderrPreview: dependencies.truncateText(run.stderr.trim(), 1200),
    runtimeDiagnostics: context.runtime?.diagnostics || [],
  };
}

/**
 * @param {Parameters<typeof createOcrCpuWorkers>[0]} dependencies
 * @param {OcrCpuWorkerContext & { chunk: OcrBatchChunk; chunkIndex: number; emitPageProgress: (progress: { itemIndex: number; phase: string; count: number }) => void }} context
 * @returns {Promise<OcrChunkRun>}
 */
async function runOcrBboxBatchChunk(dependencies, context) {
  const paths = await writeChunkControlFiles(dependencies, context);
  const workerOptions = {
    ...context.batchOptions,
    ocrWorkerThreads: dependencies.resolveOcrWorkerThreadCount(
      context.batchOptions,
    ),
  };
  const commandSpec = dependencies.buildOcrBboxBatchCommand(
    workerOptions,
    paths.batchPath,
    context.runtime,
    paths.progressPath,
  );
  const command = dependencies.formatCommandForLog(commandSpec);
  const handleProgressLine = buildChunkProgressHandler(dependencies, context);
  const poller = dependencies.createOcrBatchProgressFilePoller(
    paths.progressPath,
    handleProgressLine,
  );
  try {
    poller.start();
    const output = await dependencies.runOcrCommandWithModelRepair(
      commandSpec,
      workerOptions,
      context.runtime,
      {
        timeoutMs: dependencies.resolveOcrBboxTimeoutMs(
          context.chunk.items.length,
        ),
        onOutput: handleProgressLine,
      },
    );
    return { command, itemIndexes: context.chunk.itemIndexes, ...output };
  } finally {
    poller.stop();
    await dependencies.cleanupOcrBatchControlFiles(
      paths.batchPath,
      paths.progressPath,
      context.batchOptions,
    );
  }
}

/** @param {Parameters<typeof createOcrCpuWorkers>[0]} dependencies @param {OcrCpuWorkerContext & { chunk: OcrBatchChunk; chunkIndex: number }} context */
async function writeChunkControlFiles(dependencies, context) {
  const baseDir = context.firstOptions.outputDir || process.cwd();
  const suffix = `${Date.now()}-${process.pid}-${context.chunkIndex + 1}`;
  const batchPath = dependencies.path.join(baseDir, `ocr-batch-${suffix}.json`);
  const progressPath = dependencies.path.join(
    baseDir,
    `ocr-batch-progress-${suffix}.jsonl`,
  );
  await dependencies.mkdir(dependencies.path.dirname(batchPath), {
    recursive: true,
  });
  await dependencies.writeFile(
    batchPath,
    `${JSON.stringify({ items: context.chunk.items }, null, 2)}\n`,
    "utf8",
  );
  await dependencies.writeFile(progressPath, "", "utf8");
  return { batchPath, progressPath };
}

/** @param {Parameters<typeof createOcrCpuWorkers>[0]} dependencies @param {OcrCpuWorkerContext & { chunk: OcrBatchChunk; chunkIndex: number; emitPageProgress: (progress: { itemIndex: number; phase: string; count: number }) => void }} context */
function buildChunkProgressHandler(dependencies, context) {
  const handleCommandOutput = dependencies.createOcrCommandProgressHandler(
    context.batchOptions,
    {
      progressText: "Paddle OCR CPU 병렬 배치 위치 분석 중",
      progressCurrent:
        dependencies.readPositiveInteger(
          context.firstOptions.ocrBatchCompletedBefore,
        ) || 0,
      progressTotal:
        dependencies.readPositiveInteger(context.firstOptions.ocrBatchTotal) ||
        context.chunk.items.length,
    },
  );
  return dependencies.createProgressLineHandler({
    handleCommandOutput,
    emitPageProgress: context.emitPageProgress,
    eventKeyPrefix: String(context.chunkIndex),
    resolveItemIndex: (progress) => {
      const localIndex = Math.max(1, Number(progress.index) || 1);
      return context.chunk.itemIndexes[localIndex - 1];
    },
  });
}

/** @returns {OcrChunkRun} */
function emptyChunkRun() {
  return { command: "", itemIndexes: [], stdout: "", stderr: "" };
}

/** @param {Array<{ image: unknown; output: string }>} items @param {number} workerCount */
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

module.exports = { createOcrCpuWorkers };
