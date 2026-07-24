const { execFileSync } = require("node:child_process");
const { GPU_SAMPLE_INTERVAL_MS, RUNS_PER_CANDIDATE } = require("./config.cjs");

/**
 * @typedef {{ prompt_per_second?: unknown; predicted_per_second?: unknown; [key: string]: unknown }} BenchmarkTimings
 * @typedef {{ gpuUtilPercent: number | null; gpuUsedMb: number | null; processVramMb: number | null; timestamp: string }} GpuSnapshot
 * @typedef {{ sampleCount: number; avgGpuUtilPercent: number | null; peakGpuUtilPercent: number | null; peakProcessVramMb: number | null; peakGpuUsedMb: number | null }} GpuSummary
 * @typedef {{ runIndex: number; sampleIndex: number; imagePath: string; wallMs: number; blockCount: number; timings: BenchmarkTimings | null; gpu: GpuSummary }} MeasuredPage
 * @typedef {{ measuredPageCount: number; meanWallMs: number | null; meanPromptTokensPerSecond: number | null; meanPredictedTokensPerSecond: number | null; peakProcessVramMb: number | null; peakGpuDeltaMb: number | null; peakGpuUsedMb: number | null; minBlockCount: number; maxBlockCount: number }} MeasuredSummary
 */

/**
 * @template T
 * @param {number | null} pid
 * @param {() => Promise<T>} run
 * @returns {Promise<{ wallMs: number; result: T; gpuSamples: GpuSnapshot[] }>}
 */
async function measureGpuDuring(pid, run) {
  /** @type {GpuSnapshot[]} */
  const samples = [];
  let sampling = false;
  const timer = setInterval(() => {
    if (sampling) {
      return;
    }
    sampling = true;
    try {
      samples.push(readGpuSnapshot(pid));
    } finally {
      sampling = false;
    }
  }, GPU_SAMPLE_INTERVAL_MS);
  const startedAt = Date.now();
  try {
    const result = await run();
    samples.push(readGpuSnapshot(pid));
    return {
      wallMs: Date.now() - startedAt,
      result,
      gpuSamples: samples,
    };
  } finally {
    clearInterval(timer);
  }
}

/**
 * @param {MeasuredPage[]} pages
 * @param {GpuSnapshot | null} beforeStart
 * @returns {MeasuredSummary}
 */
function summarizeMeasuredPages(pages, beforeStart) {
  const measuredPages = pages.filter(
    (page) => RUNS_PER_CANDIDATE <= 1 || page.runIndex > 0,
  );
  const wallMsValues = measuredPages
    .map((page) => page.wallMs)
    .filter(isFiniteNumber);
  const promptPerSecond = measuredPages
    .map((page) => Number(page.timings?.prompt_per_second))
    .filter(isFiniteNumber);
  const predictedPerSecond = measuredPages
    .map((page) => Number(page.timings?.predicted_per_second))
    .filter(isFiniteNumber);
  const peakProcessVramMb = Math.max(
    0,
    ...measuredPages
      .map((page) => Number(page.gpu.peakProcessVramMb))
      .filter(isFiniteNumber),
  );
  const peakGpuUsedMb = Math.max(
    0,
    ...measuredPages
      .map((page) => Number(page.gpu.peakGpuUsedMb))
      .filter(isFiniteNumber),
  );
  const beforeGpuUsedMb = Number(beforeStart?.gpuUsedMb);
  const peakGpuDeltaMb =
    Number.isFinite(beforeGpuUsedMb) && peakGpuUsedMb > 0
      ? Math.max(0, peakGpuUsedMb - beforeGpuUsedMb)
      : null;
  return {
    measuredPageCount: measuredPages.length,
    meanWallMs: average(wallMsValues),
    meanPromptTokensPerSecond: average(promptPerSecond),
    meanPredictedTokensPerSecond: average(predictedPerSecond),
    peakProcessVramMb: peakProcessVramMb || null,
    peakGpuDeltaMb,
    peakGpuUsedMb: peakGpuUsedMb || null,
    minBlockCount: Math.min(...measuredPages.map((page) => page.blockCount)),
    maxBlockCount: Math.max(...measuredPages.map((page) => page.blockCount)),
  };
}

/**
 * @param {GpuSnapshot[]} samples
 * @returns {GpuSummary}
 */
function summarizeGpuSamples(samples) {
  const gpuUtils = samples
    .map((sample) => sample.gpuUtilPercent)
    .filter(isFiniteNumber);
  const processVram = samples
    .map((sample) => sample.processVramMb)
    .filter(isFiniteNumber);
  const gpuUsed = samples
    .map((sample) => sample.gpuUsedMb)
    .filter(isFiniteNumber);
  return {
    sampleCount: samples.length,
    avgGpuUtilPercent: average(gpuUtils),
    peakGpuUtilPercent: maxOrNull(gpuUtils),
    peakProcessVramMb: maxOrNull(processVram),
    peakGpuUsedMb: maxOrNull(gpuUsed),
  };
}

/**
 * @param {number | null} pid
 * @returns {GpuSnapshot}
 */
function readGpuSnapshot(pid) {
  const gpu = readGpuUtilAndMemory();
  return {
    ...gpu,
    processVramMb: pid ? readProcessVramMb(pid) : null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * @returns {{ gpuUtilPercent: number | null; gpuUsedMb: number | null }}
 */
function readGpuUtilAndMemory() {
  try {
    const stdout = execFileSync(
      "nvidia-smi",
      [
        "--query-gpu=utilization.gpu,memory.used",
        "--format=csv,noheader,nounits",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    ).trim();
    const [util, used] = stdout.split(/\s*,\s*/);
    return {
      gpuUtilPercent: Number(util),
      gpuUsedMb: Number(used),
    };
  } catch (_error) {
    return {
      gpuUtilPercent: null,
      gpuUsedMb: null,
    };
  }
}

/**
 * @param {number} pid
 * @returns {number | null}
 */
function readProcessVramMb(pid) {
  try {
    const stdout = execFileSync(
      "nvidia-smi",
      ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    ).trim();
    for (const line of stdout.split(/\r?\n/)) {
      const [linePid, used] = line.split(/\s*,\s*/);
      if (Number(linePid) === Number(pid)) {
        const value = Number(String(used).replace(/[^\d.]/g, ""));
        return Number.isFinite(value) ? value : null;
      }
    }
    return null;
  } catch (_error) {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return Number.isFinite(value);
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function average(values) {
  const filtered = values.filter(isFiniteNumber);
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function maxOrNull(values) {
  const filtered = values.filter(isFiniteNumber);
  return filtered.length > 0 ? Math.max(...filtered) : null;
}

module.exports = {
  measureGpuDuring,
  readGpuSnapshot,
  summarizeGpuSamples,
  summarizeMeasuredPages,
};
