// @ts-check
const { execFile } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { resolveComputeGpuIndex } = require("../compute-gpu-selection.cjs");
const {
  isSpeedGemmaModel,
  resolveLlamaRuntimeProfile,
} = require("./runtime-profile.cjs");

// GPU offload is chosen in whole model-layer groups, so sub-layer corrections
// can leave the exact same placement in VRAM. The 31B RTX 4090 probe confirmed
// that +256 MiB did not move a layer and still collapsed under WDDM pressure,
// while +512 MiB crossed the placement boundary without reducing decode speed.
const FIT_CALIBRATION_QUANTUM_MIB = 512;
const FIT_CALIBRATION_SAFETY_MIB = 128;
const FIT_CALIBRATION_TOLERANCE_MIB = 64;
const MAX_FIT_TARGET_MIB = 16_384;
const MIN_HEALTHY_DECODE_TOKENS_PER_SECOND = 10;
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
 * Calculate a one-run fit correction from physical VRAM observed after the
 * server has created its real MTP context. llama.cpp currently fits without
 * that extra context when Gemma4Assistant memory measurement fails.
 *
 * @param {{ requestedFitTargetMiB: number; observedFreeMiB: number; safetyMiB?: number; toleranceMiB?: number; quantumMiB?: number; maxFitTargetMiB?: number }} input
 */
function calculateMtpFitCorrection(input) {
  const requestedFitTargetMiB = normalizeNonNegativeInteger(
    input.requestedFitTargetMiB,
  );
  const observedFreeMiB = normalizeNonNegativeInteger(input.observedFreeMiB);
  const safetyMiB = normalizePositiveInteger(
    input.safetyMiB,
    FIT_CALIBRATION_SAFETY_MIB,
  );
  const toleranceMiB = normalizeNonNegativeInteger(
    input.toleranceMiB ?? FIT_CALIBRATION_TOLERANCE_MIB,
  );
  const quantumMiB = normalizePositiveInteger(
    input.quantumMiB,
    FIT_CALIBRATION_QUANTUM_MIB,
  );
  const maxFitTargetMiB = normalizePositiveInteger(
    input.maxFitTargetMiB,
    MAX_FIT_TARGET_MIB,
  );
  const safeObservedTargetMiB = requestedFitTargetMiB + safetyMiB;
  const missingMiB = safeObservedTargetMiB - observedFreeMiB;
  if (missingMiB <= toleranceMiB) {
    return {
      requestedFitTargetMiB,
      observedFreeMiB,
      effectiveFitTargetMiB: requestedFitTargetMiB,
      correctionMiB: 0,
      safetyMiB,
      toleranceMiB,
      quantumMiB,
    };
  }
  const roundedCorrectionMiB =
    Math.ceil((missingMiB - toleranceMiB) / quantumMiB) * quantumMiB;
  const effectiveFitTargetMiB = Math.min(
    maxFitTargetMiB,
    requestedFitTargetMiB + roundedCorrectionMiB,
  );
  return {
    requestedFitTargetMiB,
    observedFreeMiB,
    effectiveFitTargetMiB,
    correctionMiB: Math.max(0, effectiveFitTargetMiB - requestedFitTargetMiB),
    safetyMiB,
    toleranceMiB,
    quantumMiB,
  };
}

function createMtpCalibrationRequestBody() {
  return {
    model: "gemma",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: MTP_CALIBRATION_IMAGE_URL },
          },
          {
            type: "text",
            text: "Reply with the numbers one through thirty-two in English, separated by spaces.",
          },
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
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createMtpCalibrationRequestBody()),
      signal,
    });
  } finally {
    clearInterval(sampler);
    while (samplePending) await delay(10);
    await sampleFreeVram();
  }
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

/** @param {unknown} value */
function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

/** @param {unknown} value @param {number} fallback */
function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

module.exports = {
  FIT_CALIBRATION_QUANTUM_MIB,
  FIT_CALIBRATION_SAFETY_MIB,
  FIT_CALIBRATION_TOLERANCE_MIB,
  MAX_FIT_TARGET_MIB,
  MIN_HEALTHY_DECODE_TOKENS_PER_SECOND,
  calculateMtpFitCorrection,
  measureNvidiaFreeVramMiB,
  probeMtpServerPerformance,
  shouldCalibrateMtpFit,
};
