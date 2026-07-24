const { existsSync } = require("node:fs");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { nativeImage } = require("electron");
const { DEFAULT_SAMPLE_PATHS, readIntEnv } = require("./config.cjs");

/**
 * @typedef {{ id: string; name: string; imagePath: string; width: number; height: number }} BenchmarkSample
 * @typedef {{ name: string; imageMinTokens?: number; imageMaxTokens?: number; [key: string]: unknown }} BenchmarkCandidate
 * @typedef {{ imageMinTokens?: unknown; imageMaxTokens?: unknown; [key: string]: unknown }} BenchmarkOptions
 * @typedef {{ imageTokenClipped: boolean; lastCudaMemoryBreakdown: null | { selfMiB: number; modelMiB: number; contextMiB: number; computeMiB: number } }} ServerLogSummary
 */

/**
 * @param {string} imagePath
 * @param {number} index
 * @returns {BenchmarkSample}
 */
function createPageRecord(imagePath, index) {
  const image = nativeImage.createFromPath(imagePath);
  const size = image.getSize();
  if (!size.width || !size.height) {
    throw new Error(`Failed to read image dimensions: ${imagePath}`);
  }
  return {
    id: `perf-page-${index + 1}`,
    name: path.basename(imagePath),
    imagePath,
    width: size.width,
    height: size.height,
  };
}

/**
 * @returns {string[]}
 */
function resolveSamples() {
  const configured = String(process.env.MANGA_PERF_SAMPLE_PATHS || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  const limit = readIntEnv(
    "MANGA_PERF_SAMPLE_LIMIT",
    configured.length || DEFAULT_SAMPLE_PATHS.length,
  );
  return (configured.length > 0 ? configured : DEFAULT_SAMPLE_PATHS)
    .filter((item) => existsSync(item))
    .slice(0, limit);
}

/**
 * @param {BenchmarkCandidate} candidate
 * @param {BenchmarkOptions} baseOptions
 * @returns {boolean}
 */
function candidateKeepsImageTokenBudget(candidate, baseOptions) {
  const requiredBatch = Math.max(
    Number(baseOptions.imageMinTokens) || 0,
    Number(baseOptions.imageMaxTokens) || 0,
  );
  const batch = Number(candidate.batch) || 0;
  if (requiredBatch > 0 && batch < requiredBatch) {
    console.warn(
      `[perf] skip ${candidate.name}: batch=${candidate.batch} would clip image token budget ${requiredBatch}`,
    );
    return false;
  }
  if (
    requiredBatch > 0 &&
    Number(candidate.ubatch) > 0 &&
    Number(candidate.ubatch) < requiredBatch
  ) {
    console.warn(
      `[perf] allow ${candidate.name}: ubatch=${candidate.ubatch} is below image token budget; output will be checked for clipping`,
    );
  }
  return true;
}

/**
 * @param {string} filePath
 * @returns {Promise<unknown>}
 */
async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (_error) {
    return {};
  }
}

/**
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (_error) {
    return "";
  }
}

/**
 * @param {unknown} text
 * @returns {ServerLogSummary}
 */
function summarizeServerLog(text) {
  const logText = String(text ?? "");
  const imageTokenClipped =
    /clip_set_limit_image_tokens|limiting image_(?:min|max)_tokens/i.test(
      logText,
    );
  const memoryBreakdowns = [
    ...logText.matchAll(
      /\|\s+- CUDA0.*?\|\s+\d+\s*=\s*\d+\s*\+\s*\(\s*(\d+)\s*=\s*(\d+)\s*\+\s*(\d+)\s*\+\s*(\d+)\s*\)/g,
    ),
  ].map((match) => ({
    selfMiB: Number(match[1]),
    modelMiB: Number(match[2]),
    contextMiB: Number(match[3]),
    computeMiB: Number(match[4]),
  }));
  return {
    imageTokenClipped,
    lastCudaMemoryBreakdown: memoryBreakdowns.at(-1) ?? null,
  };
}

module.exports = {
  candidateKeepsImageTokenBudget,
  createPageRecord,
  readJsonIfExists,
  readTextIfExists,
  resolveSamples,
  summarizeServerLog,
};
