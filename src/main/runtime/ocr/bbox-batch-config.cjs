// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {RuntimeOptions & { ocrCpuWorkers?: unknown; ocrWorkerThreads?: unknown; ocrCpuWorkerStartDelayMs?: unknown; ocrCpuWorkerMinFreeRamPercent?: unknown; ocrCpuWorkerRamPollMs?: unknown }} OcrBboxOptions */
/** @typedef {{ os: typeof import("node:os"); runtimeOverrideEnv: (name: string, options?: RuntimeOptions) => unknown; readPositiveInteger: (value: unknown) => number | null; emitRuntimeProgress: (options: object | undefined, phase: string, progressText: string, detail?: string, progress?: Record<string, unknown>) => void }} Dependencies */

/** @param {Dependencies} dependencies */
function createOcrBatchConfig(dependencies) {
  return {
    delayForOcrWorkerStart,
    hasOcrCpuWorkerRamHeadroom,
    isExplicitCpuOcrDevice: isExplicitCpuOcrDevice.bind(null, dependencies),
    resolveOcrCpuWorkerCount: resolveOcrCpuWorkerCount.bind(null, dependencies),
    resolveOcrCpuWorkerMinFreeRamRatio: resolveOcrCpuWorkerMinFreeRamRatio.bind(
      null,
      dependencies,
    ),
    resolveOcrCpuWorkerStartDelayMs: resolveOcrCpuWorkerStartDelayMs.bind(
      null,
      dependencies,
    ),
    resolveOcrWorkerThreadCount: resolveOcrWorkerThreadCount.bind(
      null,
      dependencies,
    ),
    waitForOcrCpuWorkerRamHeadroom: waitForOcrCpuWorkerRamHeadroom.bind(
      null,
      dependencies,
    ),
    withoutPageProgressOptions,
  };
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} [options] @param {number} [pageCount] */
function resolveOcrCpuWorkerCount(dependencies, options = {}, pageCount = 1) {
  const explicit = firstPositiveInteger(dependencies, [
    dependencies.runtimeOverrideEnv(
      "MANGA_TRANSLATOR_PADDLEOCR_CPU_WORKERS",
      options,
    ),
    dependencies.runtimeOverrideEnv(
      "MANGA_TRANSLATOR_OCR_CPU_WORKERS",
      options,
    ),
    options.ocrCpuWorkers,
  ]);
  if (explicit) {
    return Math.max(1, Math.min(pageCount, explicit));
  }
  const cpuCount = Math.max(1, dependencies.os.cpus().length || 1);
  return Math.max(
    1,
    Math.min(
      pageCount,
      4,
      Math.floor(cpuCount / resolveOcrWorkerThreadCount(dependencies, options)),
    ),
  );
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} [options] */
function resolveOcrWorkerThreadCount(dependencies, options = {}) {
  return (
    firstPositiveInteger(dependencies, [
      dependencies.runtimeOverrideEnv(
        "MANGA_TRANSLATOR_PADDLEOCR_WORKER_THREADS",
        options,
      ),
      dependencies.runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_WORKER_THREADS",
        options,
      ),
      options.ocrWorkerThreads,
    ]) || 2
  );
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} [options] */
function resolveOcrCpuWorkerStartDelayMs(dependencies, options = {}) {
  return (
    firstPositiveInteger(dependencies, [
      dependencies.runtimeOverrideEnv(
        "MANGA_TRANSLATOR_PADDLEOCR_CPU_WORKER_START_DELAY_MS",
        options,
      ),
      dependencies.runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_CPU_WORKER_START_DELAY_MS",
        options,
      ),
      options.ocrCpuWorkerStartDelayMs,
    ]) || 250
  );
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} [options] */
function resolveOcrCpuWorkerMinFreeRamRatio(dependencies, options = {}) {
  const explicit = firstOptionalNumber([
    dependencies.runtimeOverrideEnv(
      "MANGA_TRANSLATOR_PADDLEOCR_CPU_WORKER_MIN_FREE_RAM_PERCENT",
      options,
    ),
    dependencies.runtimeOverrideEnv(
      "MANGA_TRANSLATOR_OCR_CPU_WORKER_MIN_FREE_RAM_PERCENT",
      options,
    ),
    options.ocrCpuWorkerMinFreeRamPercent,
  ]);
  const defaultPercent = dependencies.os.platform() === "darwin" ? 0 : 20;
  return Math.max(0, Math.min(95, explicit ?? defaultPercent)) / 100;
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} [options] */
function resolveOcrCpuWorkerRamPollMs(dependencies, options = {}) {
  return (
    firstPositiveInteger(dependencies, [
      dependencies.runtimeOverrideEnv(
        "MANGA_TRANSLATOR_PADDLEOCR_CPU_WORKER_RAM_POLL_MS",
        options,
      ),
      dependencies.runtimeOverrideEnv(
        "MANGA_TRANSLATOR_OCR_CPU_WORKER_RAM_POLL_MS",
        options,
      ),
      options.ocrCpuWorkerRamPollMs,
    ]) || 1000
  );
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} [options] @param {number} [chunkIndex] */
async function waitForOcrCpuWorkerRamHeadroom(
  dependencies,
  options = {},
  chunkIndex = 0,
) {
  if (chunkIndex <= 0) {
    return;
  }
  const minFreeRatio = resolveOcrCpuWorkerMinFreeRamRatio(
    dependencies,
    options,
  );
  if (minFreeRatio <= 0) {
    return;
  }
  const pollMs = resolveOcrCpuWorkerRamPollMs(dependencies, options);
  let reported = false;
  while (
    !hasOcrCpuWorkerRamHeadroom(readSystemRamInfo(dependencies), minFreeRatio)
  ) {
    if (!reported) {
      emitRamWaitProgress(dependencies, options, minFreeRatio);
      reported = true;
    }
    await delayForOcrWorkerStart(pollMs, options.abortSignal);
  }
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} options @param {number} minFreeRatio */
function emitRamWaitProgress(dependencies, options, minFreeRatio) {
  const info = readSystemRamInfo(dependencies);
  dependencies.emitRuntimeProgress(
    options,
    "ocr_running",
    "Paddle OCR CPU 워커 RAM 대기 중",
    `여유 RAM ${formatPercent(info.freeRatio)} / 목표 ${formatPercent(minFreeRatio)}`,
    { pageIndex: null, pageTotal: null, progressMode: "log-only" },
  );
}

/** @param {Dependencies} dependencies */
function readSystemRamInfo(dependencies) {
  const freeBytes = Number(dependencies.os.freemem());
  const totalBytes = Number(dependencies.os.totalmem());
  const freeRatio =
    Number.isFinite(freeBytes) && Number.isFinite(totalBytes) && totalBytes > 0
      ? freeBytes / totalBytes
      : Number.NaN;
  return { freeBytes, totalBytes, freeRatio };
}

/** @param {Dependencies} dependencies @param {OcrBboxOptions} [options] */
function isExplicitCpuOcrDevice(dependencies, options = {}) {
  return [
    options.ocrDevice,
    dependencies.runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options),
    dependencies.runtimeOverrideEnv(
      "MANGA_TRANSLATOR_PADDLEOCR_DEVICE",
      options,
    ),
  ].some(isCpuValue);
}

/** @param {RuntimeOptions} [options] */
function withoutPageProgressOptions(options = {}) {
  const next = { ...options };
  delete next.ocrPageIndex;
  delete next.ocrPageTotal;
  delete next.ocrProgressDefaultToPage;
  delete next.pageIndex;
  delete next.pageTotal;
  return next;
}

/** @param {Dependencies} dependencies @param {unknown[]} values */
function firstPositiveInteger(dependencies, values) {
  for (const value of values) {
    const parsed = dependencies.readPositiveInteger(value);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

/** @param {{ freeRatio: number } | null | undefined} info @param {number} minFreeRatio */
function hasOcrCpuWorkerRamHeadroom(info, minFreeRatio) {
  if (!Number.isFinite(minFreeRatio) || minFreeRatio <= 0) {
    return true;
  }
  return !info || !Number.isFinite(info.freeRatio)
    ? true
    : info.freeRatio >= minFreeRatio;
}

/** @param {unknown[]} values */
function firstOptionalNumber(values) {
  for (const value of values) {
    const parsed = readOptionalNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

/** @param {unknown} value */
function readOptionalNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {unknown} value */
function isCpuValue(value) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase() === "cpu"
  );
}

/** @param {number} value */
function formatPercent(value) {
  return `${Math.round(value * 1000) / 10}%`;
}

/** @param {number} delayMs @param {AbortSignal | null | undefined} signal */
function delayForOcrWorkerStart(delayMs, signal) {
  if (!delayMs || delayMs <= 0) {
    return signal?.aborted
      ? Promise.reject(createAbortError())
      : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const finish = () => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve(undefined);
    };
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function createAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("Aborted", "AbortError");
  }
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

module.exports = { createOcrBatchConfig };
