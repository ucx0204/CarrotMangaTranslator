// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/**
 * @typedef {RuntimeOptions & {
 *   ocrDevice?: unknown;
 *   ocrDeviceOverride?: unknown;
 *   ocrGpuBackend?: unknown;
 *   ocrGpuCudaTag?: unknown;
 *   [key: string]: unknown;
 * }} OcrConfigOptions
 */

const { DEFAULT_OCR_GPU_CUDA_TAG } = require("../simple-page-defaults.cjs");
const { runtimeOverrideEnv } = require("./host-services.cjs");
const { readPositiveInteger } = require("./config-values.cjs");

const CUDA_BACKEND_ALIASES = new Set(["cuda", "nvidia"]);
const ROCM_BACKEND_ALIASES = new Set([
  "rocm",
  "amd",
  "hip",
  "rocm-transformers",
  "transformers-rocm",
]);

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
  const raw = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG", options) ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_CUDA_TAG", options) ??
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
function resolveOcrGpuPackageIndexUrl(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL", options) ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL", options) ??
      `https://www.paddlepaddle.org.cn/packages/stable/${resolveOcrGpuCudaTag(options)}/`,
  ).trim();
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrRuntimeVariant(options = {}) {
  if (!isOcrGpuRequested(options)) {
    return "cpu";
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return "gpu-rocm-transformers";
  }
  return `gpu-${resolveOcrGpuCudaTag(options)}`
    .replace(/[^a-z0-9._-]+/gi, "-")
    .toLowerCase();
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrDevice(options = /** @type {OcrConfigOptions} */ ({})) {
  const explicitDevice = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_DEVICE", options) ?? "",
  ).trim();
  if (explicitDevice) {
    return explicitDevice;
  }
  return normalizeConfiguredOcrDevice(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options) ??
      options.ocrDevice ??
      "cpu",
  );
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
  const override = String(options.ocrDeviceOverride ?? "")
    .trim()
    .toLowerCase();
  if (override === "cpu") {
    return "cpu";
  }
  if (!override.startsWith("gpu")) {
    return resolveOcrDevice(options);
  }
  return override === "gpu" ? "gpu:0" : override;
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrDeviceLabel(options = {}) {
  const device = resolveEffectiveOcrDevice(options);
  if (device !== "cpu") {
    return device.toUpperCase();
  }
  return device !== resolveOcrDevice(options) ? "CPU(GPU 폴백)" : "CPU";
}

/** @param {RuntimeOptions} [options] @returns {number} */
function resolvePaddleOcrImportCheckTimeoutMs(options = {}) {
  const explicit = readPositiveInteger(
    process.env.MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS,
  );
  if (explicit) {
    return explicit;
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
  isOcrGpuRequested,
  resolveEffectiveOcrDevice,
  resolveOcrDevice,
  resolveOcrDeviceLabel,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrRuntimeVariant,
  resolvePaddleOcrImportCheckTimeoutMs,
};
