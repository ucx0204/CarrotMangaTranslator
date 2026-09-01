// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & {
 *   ocrDevice?: unknown;
 *   ocrGpuBackend?: unknown;
 *   ocrGpuCudaTag?: unknown;
 *   ocrEngine?: unknown;
 *   [key: string]: unknown;
 * }} OcrConfigOptions
 */

const { DEFAULT_OCR_GPU_CUDA_TAG } = require("../simple-page-defaults.cjs");
const { runtimeOverrideEnv } = require("./host-services.cjs");
const { readPositiveInteger } = require("./config-values.cjs");
const {
  assertPaddleLegacyOcrPipeline,
  isHayaiOcrPipeline,
  isManagedOcrBboxProvider,
  resolveOcrBboxProviderForRequest,
  resolveOcrEngineLabel,
} = require("./engine-profile.cjs");

const CUDA_BACKEND_ALIASES = new Set(["cuda", "nvidia"]);
const ROCM_BACKEND_ALIASES = new Set([
  "rocm",
  "amd",
  "hip",
  "rocm-transformers",
  "transformers-rocm",
]);
const DEFAULT_OCR_TORCH_CUDA_TAG = DEFAULT_OCR_GPU_CUDA_TAG;
const BLACKWELL_OCR_TORCH_CUDA_TAG = "cu130";

/** @param {RuntimeOptions} [options] @returns {boolean} */
function isOcrGpuRequested(options = {}) {
  return resolveOcrDevice(options).startsWith("gpu");
}

/** @param {RuntimeOptions} [options] @returns {boolean} */
function isOcrBlackwellCudaTag(options = {}) {
  return (
    resolveOcrGpuBackend(options) === "cuda" &&
    resolveOcrGpuCudaTag(options) === "cu129"
  );
}

/** @param {RuntimeOptions} [options] @returns {"cuda" | "rocm-transformers"} */
function resolveOcrGpuBackend(options = /** @type {OcrConfigOptions} */ ({})) {
  const normalized = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_BACKEND", options) ??
      options.ocrGpuBackend ??
      "cuda",
  )
    .trim()
    .toLowerCase();
  if (CUDA_BACKEND_ALIASES.has(normalized)) {
    return "cuda";
  }
  return ROCM_BACKEND_ALIASES.has(normalized) ? "rocm-transformers" : "cuda";
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrGpuCudaTag(options = /** @type {OcrConfigOptions} */ ({})) {
  const legacyCudaTag = isHayaiOcrPipeline(options)
    ? undefined
    : runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG", options);
  const raw = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", options) ??
      legacyCudaTag ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA", options) ??
      options.ocrGpuCudaTag ??
      DEFAULT_OCR_GPU_CUDA_TAG,
  )
    .trim()
    .toLowerCase();
  if (/^cu\d+$/.test(raw)) {
    return raw;
  }
  const digits = raw.replace(/\D/g, "");
  return digits ? `cu${digits}` : DEFAULT_OCR_GPU_CUDA_TAG;
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolvePaddleOcrGpuPackageIndexUrl(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  assertPaddleLegacyOcrPipeline(options, "Paddle OCR package index");
  return String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL", options) ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL", options) ??
      `https://www.paddlepaddle.org.cn/packages/stable/${resolveOcrGpuCudaTag(options)}/`,
  ).trim();
}

/** @param {RuntimeOptions} [options] @returns {boolean} */
function isPaddleTransformersEngine(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  if (isHayaiOcrPipeline(options)) {
    return false;
  }
  const configuredEngine = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_ENGINE", options) ??
      options.ocrEngine ??
      "",
  )
    .trim()
    .toLowerCase();
  if (configuredEngine) {
    return configuredEngine === "transformers";
  }
  return (
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  );
}

/** @param {RuntimeOptions} [options] @returns {boolean} */
function isOcrTorchRuntime(options = {}) {
  if (isHayaiOcrPipeline(options)) {
    return true;
  }
  return isOcrGpuRequested(options) && isPaddleTransformersEngine(options);
}

/** @param {RuntimeOptions} [options] @returns {boolean} */
function isOcrCudaTorchRuntime(options = {}) {
  return (
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "cuda" &&
    (isHayaiOcrPipeline(options) || isPaddleTransformersEngine(options))
  );
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrTorchCudaTag(options = {}) {
  const explicit = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_TORCH_CUDA_TAG", options) ?? "",
  )
    .trim()
    .toLowerCase();
  if (/^cu\d+$/.test(explicit)) {
    return explicit;
  }
  const paddleCuda = Number(resolveOcrGpuCudaTag(options).replace(/\D/g, ""));
  return paddleCuda >= 129
    ? BLACKWELL_OCR_TORCH_CUDA_TAG
    : DEFAULT_OCR_TORCH_CUDA_TAG;
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrTorchPackageIndexUrl(options = {}) {
  return String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_TORCH_INDEX_URL", options) ??
      `https://download.pytorch.org/whl/${resolveOcrTorchCudaTag(options)}`,
  ).trim();
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrRuntimeVariant(options = {}) {
  if (isHayaiOcrPipeline(options)) {
    if (!isOcrGpuRequested(options)) {
      return "hayai-cpu";
    }
    if (resolveOcrGpuBackend(options) === "rocm-transformers") {
      return "hayai-rocm";
    }
    return `hayai-cuda-${resolveOcrTorchCudaTag(options)}`
      .replace(/[^a-z0-9._-]+/gi, "-")
      .toLowerCase();
  }
  if (!isOcrGpuRequested(options)) {
    return isOcrTorchRuntime(options) ? "cpu-transformers" : "cpu";
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return "gpu-rocm-transformers";
  }
  if (isOcrCudaTorchRuntime(options)) {
    return `gpu-cuda-transformers-${resolveOcrTorchCudaTag(options)}`
      .replace(/[^a-z0-9._-]+/gi, "-")
      .toLowerCase();
  }
  return `gpu-${resolveOcrGpuCudaTag(options)}`
    .replace(/[^a-z0-9._-]+/gi, "-")
    .toLowerCase();
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrDevice(options = /** @type {OcrConfigOptions} */ ({})) {
  const legacyDevice = isHayaiOcrPipeline(options)
    ? undefined
    : runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_DEVICE", options);
  const explicitDevice = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options) ??
      legacyDevice ??
      "",
  ).trim();
  if (explicitDevice) {
    return explicitDevice;
  }
  return normalizeConfiguredOcrDevice(options.ocrDevice ?? "cpu");
}

/** @param {unknown} value @returns {string} */
function normalizeConfiguredOcrDevice(value) {
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "gpu" || normalized === "cuda") {
    return "gpu:0";
  }
  return normalized.startsWith("gpu") ? normalized : "cpu";
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveEffectiveOcrDevice(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return resolveOcrDevice(options);
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrDeviceLabel(options = {}) {
  const device = resolveEffectiveOcrDevice(options);
  if (device !== "cpu") {
    return device.toUpperCase();
  }
  return "CPU";
}

/** @param {RuntimeOptions} [options] @returns {number} */
function resolveOcrImportCheckTimeoutMs(options = {}) {
  const explicit = readPositiveInteger(
    process.env.MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS,
  );
  if (explicit) {
    return explicit;
  }
  if (isOcrTorchRuntime(options)) {
    return 300000;
  }
  if (!isOcrGpuRequested(options)) {
    return 120000;
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return 300000;
  }
  return isOcrBlackwellCudaTag(options) ? 300000 : 180000;
}

module.exports = {
  isOcrBlackwellCudaTag,
  isOcrCudaTorchRuntime,
  isOcrGpuRequested,
  isOcrTorchRuntime,
  isPaddleTransformersEngine,
  isHayaiOcrPipeline,
  isManagedOcrBboxProvider,
  resolveEffectiveOcrDevice,
  resolveOcrDevice,
  resolveOcrDeviceLabel,
  resolveOcrBboxProviderForRequest,
  resolveOcrEngineLabel,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolvePaddleOcrGpuPackageIndexUrl,
  resolveOcrRuntimeVariant,
  resolveOcrTorchCudaTag,
  resolveOcrTorchPackageIndexUrl,
  resolveOcrImportCheckTimeoutMs,
};
