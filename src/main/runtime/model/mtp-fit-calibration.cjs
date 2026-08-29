// @ts-check
const { execFile } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { resolveComputeGpuIndex } = require("../compute-gpu-selection.cjs");
const {
  isSpeedGemmaModel,
  resolveLlamaRuntimeProfile,
} = require("./runtime-profile.cjs");

const MIN_HEALTHY_DECODE_TOKENS_PER_SECOND = 10;
const MTP_FIT_STARTUP_TIMEOUT_MS = 60_000;
const MTP_CALIBRATION_IMAGE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions & Record<string, any>} CalibrationOptions */

/**
 * @param {CalibrationOptions} options
 * @param {NodeJS.Platform} [platform]
 */
function shouldCalibrateMtpFit(options, platform = process.platform) {
  if (platform !== "win32") return false;
  if (!isSpeedGemmaModel(options)) return false;
  if (!options.useDraft) return false;
  if (String(options.draftSpecType || "").toLowerCase() !== "draft-mtp") {
    return false;
  }
  if (options.gpuLayers !== "fit") return false;
  return ["cuda12", "rtx50"].includes(resolveLlamaRuntimeProfile(options));
}

/**
 * MTP fitting can omit the assistant context from its estimate. Bound only
 * that known-risk startup path; ordinary model loads retain the long timeout.
 * @param {CalibrationOptions} options
 * @param {number} defaultTimeoutMs
 * @param {NodeJS.Platform} [platform]
 */
function resolveMtpStartupTimeoutMs(
  options,
  defaultTimeoutMs,
  platform = process.platform,
) {
  return shouldCalibrateMtpFit(options, platform)
    ? MTP_FIT_STARTUP_TIMEOUT_MS
    : defaultTimeoutMs;
}

/** @param {unknown} error @param {CalibrationOptions} options @param {number | null} observedFreeMiB @param {NodeJS.Platform} [platform] */
function isLikelyMtpVramThrottle(
  error,
  options,
  observedFreeMiB,
  platform = process.platform,
) {
  const message = error instanceof Error ? error.message : String(error);
  const requestedFreeMiB = Number(options.fitTargetMb ?? 0);
  return Boolean(
    shouldCalibrateMtpFit(options, platform) &&
    message.includes("Timed out while waiting for llama-server") &&
    Number.isFinite(observedFreeMiB) &&
    Number(observedFreeMiB) < requestedFreeMiB,
  );
}

/** @param {Record<string, any>} [options] */
function createMtpCalibrationRequestBody(options = {}) {
  const textPart = {
    type: "text",
    text: "Reply with the numbers one through thirty-two in English, separated by spaces.",
  };
  return {
    model: "gemma",
    messages: [
      {
        role: "user",
        content: options.textOnlyModel
          ? [textPart]
          : [
              {
                type: "image_url",
                image_url: { url: MTP_CALIBRATION_IMAGE_URL },
              },
              textPart,
            ],
      },
    ],
    max_tokens: 32,
    temperature: 0,
    seed: 424242,
    stream: false,
    cache_prompt: false,
    ignore_eos: true,
    reasoning_format: "none",
    reasoning_budget: 0,
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
  };
}

/**
 * @param {string} baseUrl
 * @param {CalibrationOptions} options
 */
// eslint-disable-next-line complexity -- bounded fetch, abort ownership, and concurrent VRAM sampling are one startup probe lifecycle
async function probeMtpServerPerformance(baseUrl, options) {
  const startedAt = Date.now();
  const signal = createBoundedAbortSignal(options.abortSignal, 30_000);
  /** @type {number[]} */
  const freeVramSamples = [];
  let samplePending = false;
  const sampleFreeVram = async () => {
    if (samplePending) return;
    samplePending = true;
    try {
      const sample = await queryNvidiaFreeVramMiB(options.computeGpuIndex);
      if (sample !== null) freeVramSamples.push(sample);
    } finally {
      samplePending = false;
    }
  };
  await sampleFreeVram();
  const sampler = setInterval(() => void sampleFreeVram(), 100);
  let response;
  let timedOut = false;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createMtpCalibrationRequestBody(options)),
      signal,
    });
  } catch (error) {
    if (options.abortSignal?.aborted) throw error;
    if (!signal.aborted || signal.reason?.name !== "TimeoutError") throw error;
    timedOut = true;
  } finally {
    clearInterval(sampler);
    while (samplePending) await delay(10);
    await sampleFreeVram();
  }
  if (timedOut) {
    return {
      wallMs: Date.now() - startedAt,
      minimumFreeMiB: freeVramSamples.length
        ? Math.min(...freeVramSamples)
        : null,
      predictedTokens: null,
      predictedPerSecond: null,
      healthy: false,
      timedOut: true,
    };
  }
  if (!response) throw new Error("MTP startup probe returned no response.");
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `MTP startup probe failed with HTTP ${response.status}: ${raw.slice(0, 500)}`,
    );
  }
  const parsed = JSON.parse(raw);
  const timings = parsed?.timings || {};
  const predictedTokens = finiteNumberOrNull(timings.predicted_n);
  const predictedPerSecond = finiteNumberOrNull(timings.predicted_per_second);
  return {
    wallMs: Date.now() - startedAt,
    minimumFreeMiB: freeVramSamples.length
      ? Math.min(...freeVramSamples)
      : null,
    predictedTokens,
    predictedPerSecond,
    healthy:
      predictedPerSecond === null ||
      predictedTokens === null ||
      predictedTokens < 4 ||
      predictedPerSecond >= MIN_HEALTHY_DECODE_TOKENS_PER_SECOND,
    timedOut: false,
  };
}

/** @param {CalibrationOptions} options */
async function measureNvidiaFreeVramMiB(options) {
  const samples = [];
  for (let index = 0; index < 3; index += 1) {
    const sample = await queryNvidiaFreeVramMiB(options.computeGpuIndex);
    if (sample !== null) samples.push(sample);
    if (index < 2) {
      await delay(120, undefined, {
        signal: options.abortSignal ?? undefined,
      });
    }
  }
  return samples.length ? Math.min(...samples) : null;
}

/** @param {unknown} configuredIndex */
function queryNvidiaFreeVramMiB(configuredIndex) {
  const computeGpuIndex = resolveComputeGpuIndex(configuredIndex);
  const args = [
    "--query-gpu=index,memory.free",
    "--format=csv,noheader,nounits",
  ];
  if (computeGpuIndex !== null) args.unshift("--id", String(computeGpuIndex));
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      args,
      { timeout: 5_000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null);
        const values = String(stdout || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => Number(line.split(",").at(-1)?.trim()))
          .filter((value) => Number.isFinite(value) && value >= 0);
        resolve(values.length ? Math.min(...values) : null);
      },
    );
  });
}

/** @param {AbortSignal | null | undefined} external @param {number} timeoutMs */
function createBoundedAbortSignal(external, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!external) return timeoutSignal;
  return AbortSignal.any([external, timeoutSignal]);
}

/** @param {unknown} value */
function finiteNumberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

module.exports = {
  MIN_HEALTHY_DECODE_TOKENS_PER_SECOND,
  MTP_FIT_STARTUP_TIMEOUT_MS,
  createMtpCalibrationRequestBody,
  isLikelyMtpVramThrottle,
  measureNvidiaFreeVramMiB,
  probeMtpServerPerformance,
  resolveMtpStartupTimeoutMs,
  shouldCalibrateMtpFit,
};
