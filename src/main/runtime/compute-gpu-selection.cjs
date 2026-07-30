// @ts-check

const MIN_COMPUTE_GPU_INDEX = 0;
const MAX_COMPUTE_GPU_INDEX = 15;
const GPU_VISIBILITY_ENV_KEYS = [
  "CUDA_VISIBLE_DEVICES",
  "HIP_VISIBLE_DEVICES",
  "ROCR_VISIBLE_DEVICES",
  "GPU_DEVICE_ORDINAL",
];

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function resolveComputeGpuIndex(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) &&
    parsed >= MIN_COMPUTE_GPU_INDEX &&
    parsed <= MAX_COMPUTE_GPU_INDEX
    ? parsed
    : null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {unknown} value
 * @param {"cuda" | "rocm"} backend
 * @param {NodeJS.Platform} [platform]
 * @returns {NodeJS.ProcessEnv}
 */
function applyComputeGpuVisibilityEnv(
  env,
  value,
  backend,
  platform = process.platform,
) {
  const index = resolveComputeGpuIndex(value);
  if (index === null) {
    return env;
  }
  for (const key of GPU_VISIBILITY_ENV_KEYS) {
    delete env[key];
  }
  const device = String(index);
  const key =
    backend === "rocm"
      ? platform === "win32"
        ? "HIP_VISIBLE_DEVICES"
        : "ROCR_VISIBLE_DEVICES"
      : "CUDA_VISIBLE_DEVICES";
  env[key] = device;
  return env;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ computeGpuIndex?: unknown }} options
 * @param {{ ocrDevice: string; ocrGpuBackend: string }} context
 */
function applyOcrComputeGpuVisibility(env, options, context) {
  if (!context.ocrDevice.startsWith("gpu")) {
    return;
  }
  applyComputeGpuVisibilityEnv(
    env,
    options.computeGpuIndex,
    context.ocrGpuBackend === "rocm-transformers" ? "rocm" : "cuda",
  );
}

module.exports = {
  applyComputeGpuVisibilityEnv,
  applyOcrComputeGpuVisibility,
  resolveComputeGpuIndex,
};
