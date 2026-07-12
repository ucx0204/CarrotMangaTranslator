// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {RuntimeOptions & { ocrBatchCompletedBefore?: unknown; ocrBatchTotal?: unknown; ocrPageTotal?: unknown }} OcrBboxOptions */
/** @typedef {{ readPositiveInteger: (value: unknown) => number | null; emitRuntimeProgress: (options: object | undefined, phase: string, progressText: string, detail?: string, progress?: Record<string, unknown>) => void; parseOcrBatchProgressLine: (line: string) => { index: number; total: number; phase?: string; count?: number } | null }} Dependencies */

/** @param {Dependencies} dependencies */
function createOcrBatchProgress(dependencies) {
  return {
    createOcrBatchProgressEmitter: createOcrBatchProgressEmitter.bind(
      null,
      dependencies,
    ),
    createProgressLineHandler: createProgressLineHandler.bind(
      null,
      dependencies,
    ),
  };
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} batchOptions @param {OcrBboxOptions} firstOptions @param {OcrBboxOptions[]} normalizedOptions */
function createOcrBatchProgressEmitter(
  dependencies,
  batchOptions,
  firstOptions,
  normalizedOptions,
) {
  const completedBefore = readPositive(
    dependencies,
    firstOptions.ocrBatchCompletedBefore,
    0,
  );
  const batchTotal = readPositive(
    dependencies,
    firstOptions.ocrBatchTotal,
    normalizedOptions.length,
  );
  let completed = completedBefore;
  /** @param {{ itemIndex: number; phase: string; count: number }} progress */
  return (progress) => {
    const { itemIndex, phase, count } = progress;
    const pageOptions = normalizedOptions[itemIndex] || firstOptions;
    const pageTotal = readPositive(
      dependencies,
      pageOptions.ocrPageTotal,
      batchTotal,
    );
    if (phase !== "start") {
      completed = Math.min(pageTotal, completed + 1);
    }
    const label = Math.min(
      pageTotal,
      phase === "start" ? completed + 1 : completed,
    );
    emitPageProgress(dependencies, batchOptions, {
      completed,
      count,
      label,
      pageTotal,
      phase,
    });
  };
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {{ completed: number; count: number; label: number; pageTotal: number; phase: string }} progress */
function emitPageProgress(dependencies, options, progress) {
  dependencies.emitRuntimeProgress(
    options,
    "ocr_running",
    progressTitle(progress),
    progressDetail(progress),
    {
      progressCurrent: progress.completed,
      progressTotal: progress.pageTotal,
      pageIndex: progress.label,
      pageTotal: progress.pageTotal,
    },
  );
}

/** @param {{ label: number; pageTotal: number; phase: string }} progress */
function progressTitle(progress) {
  return progress.phase === "error"
    ? `${progress.label} / ${progress.pageTotal} 페이지 OCR 실패 (건너뜀)`
    : `${progress.label} / ${progress.pageTotal} 페이지 Paddle OCR 분석 중`;
}

/** @param {{ count: number; phase: string }} progress */
function progressDetail(progress) {
  if (progress.phase === "start") {
    return "페이지 처리 시작";
  }
  return progress.phase === "error"
    ? "GPU 메모리 부족 등으로 이 페이지를 건너뛰었습니다"
    : `${progress.count}개 후보`;
}

/** @typedef {{ handleCommandOutput: (line: string) => void; emitPageProgress: (progress: { itemIndex: number; phase: string; count: number }) => void; resolveItemIndex?: (progress: { index: number; total: number }) => number | undefined; eventKeyPrefix?: string }} ProgressHandlerOptions */
/** @param {Dependencies} dependencies @param {ProgressHandlerOptions} options */
function createProgressLineHandler(dependencies, options) {
  const seen = new Set();
  /** @param {string} line */
  return (line) => {
    const progress = dependencies.parseOcrBatchProgressLine(line);
    if (!progress) {
      options.handleCommandOutput(line);
      return;
    }
    const itemIndex = options.resolveItemIndex
      ? options.resolveItemIndex(progress)
      : progress.index - 1;
    if (itemIndex === undefined) {
      return;
    }
    const phase = progress.phase || "done";
    const key = `${options.eventKeyPrefix || ""}:${phase}:${progress.index}:${progress.total}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.emitPageProgress({
      itemIndex,
      phase,
      count: Number(progress.count) || 0,
    });
  };
}

/** @param {Dependencies} dependencies @param {unknown} value @param {number} fallback */
function readPositive(dependencies, value, fallback) {
  return dependencies.readPositiveInteger(value) || fallback;
}

module.exports = { createOcrBatchProgress };
