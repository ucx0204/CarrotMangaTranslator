// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/** @typedef {RuntimeOptions & { outputDir?: string | null; ocrBatchCompletedBefore?: unknown; ocrBatchTotal?: unknown }} OcrBboxOptions */
/** @typedef {{ hints: unknown[]; diagnostics: unknown[]; noTextDetected: boolean; textEvidenceCount: number }} OcrBboxResult */
/** @typedef {{ image: unknown; output: string }} OcrBatchItem */
/** @typedef {{ batchOptions: OcrBboxOptions; firstOptions: OcrBboxOptions; items: OcrBatchItem[]; normalizedOptions: OcrBboxOptions[]; provider: string; runtime: OcrRuntimeLayout | null }} OcrBatchContext */
/** @typedef {{ path: typeof import("node:path"); isOcrGpuRequested: (options?: OcrBboxOptions) => boolean; resolveEffectiveOcrDevice: (options?: OcrBboxOptions) => string; canFallBackToCpuAfterGpuFailure: (options: OcrBboxOptions, error: unknown) => boolean; buildPaddleOcrGpuFailureMessage: (error: unknown, options?: OcrBboxOptions) => string; disableOcrGpuForSession: (reason: unknown) => void; readCompletedOcrBatchOutputPayload: (path: string) => unknown; readPositiveInteger: (value: unknown) => number | null; buildCpuFallbackOcrOptions: (options: OcrBboxOptions) => OcrBboxOptions; emitRuntimeProgress: (options: object | undefined, phase: string, progressText: string, detail?: string, progress?: Record<string, unknown>) => void; normalizeOcrBboxHintPayload: (payload: unknown, options?: OcrBboxOptions) => unknown[]; buildOcrBboxResult: (hints?: unknown[], diagnostics?: unknown[], options?: Record<string, unknown>) => OcrBboxResult }} Dependencies */

/** @param {Dependencies} dependencies */
function createOcrBatchRecovery(dependencies) {
  return {
    recoverOcrBatchWithCpuFallback: recoverOcrBatchWithCpuFallback.bind(
      null,
      dependencies,
    ),
  };
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context @param {unknown} error @param {(options: OcrBboxOptions[]) => Promise<OcrBboxResult[]>} collectBatch @returns {Promise<OcrBboxResult[] | null>} */
async function recoverOcrBatchWithCpuFallback(
  dependencies,
  context,
  error,
  collectBatch,
) {
  if (!canRecoverOnCpu(dependencies, context.batchOptions, error)) {
    return null;
  }
  const message = dependencies.buildPaddleOcrGpuFailureMessage(
    error,
    context.batchOptions,
  );
  dependencies.disableOcrGpuForSession(message);
  const completed = collectCompletedPayloads(dependencies, context.items);
  const remaining = buildRemainingPages(dependencies, context, completed);
  emitCpuRecoveryStarted(dependencies, context, remaining.length, message);
  const fallbackResults = await runRemainingOnCpu(remaining, collectBatch);
  return mergeRecoveredResults(
    dependencies,
    context,
    completed,
    remaining,
    fallbackResults,
  );
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {unknown} error */
function canRecoverOnCpu(dependencies, options, error) {
  return (
    dependencies.isOcrGpuRequested(options) &&
    dependencies.resolveEffectiveOcrDevice(options) !== "cpu" &&
    dependencies.canFallBackToCpuAfterGpuFailure(options, error)
  );
}

/** @param {Dependencies} dependencies @param {OcrBatchItem[]} items */
function collectCompletedPayloads(dependencies, items) {
  const payloads = new Map();
  for (const [index, item] of items.entries()) {
    const payload = dependencies.readCompletedOcrBatchOutputPayload(
      item.output,
    );
    if (payload !== null) {
      payloads.set(index, payload);
    }
  }
  return payloads;
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context @param {Map<number, unknown>} completed */
function buildRemainingPages(dependencies, context, completed) {
  const completedBefore =
    dependencies.readPositiveInteger(
      context.firstOptions.ocrBatchCompletedBefore,
    ) || 0;
  const batchTotal =
    dependencies.readPositiveInteger(context.firstOptions.ocrBatchTotal) ||
    context.normalizedOptions.length;
  return context.normalizedOptions.flatMap((options, index) =>
    completed.has(index)
      ? []
      : [
          {
            index,
            options: {
              ...dependencies.buildCpuFallbackOcrOptions(options),
              outputDir: dependencies.path.dirname(context.items[index].output),
              ocrBatchCompletedBefore: completedBefore + completed.size,
              ocrBatchTotal: batchTotal,
            },
          },
        ],
  );
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context @param {number} count @param {string} message */
function emitCpuRecoveryStarted(dependencies, context, count, message) {
  dependencies.emitRuntimeProgress(
    context.batchOptions,
    "ocr_running",
    `Paddle OCR GPU 실행 실패 — 남은 ${count}페이지를 CPU로 이어서 처리합니다`,
    message,
    { progressMode: "log-only" },
  );
}

/** @param {Array<{ index: number; options: OcrBboxOptions }>} remaining @param {(options: OcrBboxOptions[]) => Promise<OcrBboxResult[]>} collectBatch */
async function runRemainingOnCpu(remaining, collectBatch) {
  return remaining.length > 0
    ? await collectBatch(remaining.map((entry) => entry.options))
    : [];
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context @param {Map<number, unknown>} completed @param {Array<{ index: number; options: OcrBboxOptions }>} remaining @param {OcrBboxResult[]} fallbackResults */
function mergeRecoveredResults(
  dependencies,
  context,
  completed,
  remaining,
  fallbackResults,
) {
  const fallbackByIndex = new Map(
    remaining.map((entry, position) => [
      entry.index,
      fallbackResults[position],
    ]),
  );
  return context.normalizedOptions.map(
    (options, index) =>
      fallbackByIndex.get(index) ||
      buildCompletedGpuResult(dependencies, context, completed, options, index),
  );
}

/** @param {Dependencies} dependencies @param {OcrBatchContext} context @param {Map<number, unknown>} completed @param {OcrBboxOptions} options @param {number} index */
function buildCompletedGpuResult(
  dependencies,
  context,
  completed,
  options,
  index,
) {
  const hints = dependencies.normalizeOcrBboxHintPayload(
    completed.get(index),
    options,
  );
  return dependencies.buildOcrBboxResult(hints, [
    {
      provider: context.provider,
      outputPath: context.items[index].output,
      runtimeDir: context.runtime?.runtimeDir || null,
      runtimeVariant: context.runtime?.runtimeVariant || null,
      packageDir: context.runtime?.packageDir || null,
      pythonPath: context.runtime?.pythonPath || null,
      runtimePrepared: Boolean(context.runtime?.prepared),
      hintCount: hints.length,
      resumedFrom: "gpu",
      runtimeDiagnostics: context.runtime?.diagnostics || [],
    },
  ]);
}

module.exports = { createOcrBatchRecovery };
