// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

const { existsSync } = require("node:fs");
const path = require("node:path");
const { runtimeOverrideEnv } = require("./host-services.cjs");
const {
  resolveOcrRuntimeVariant,
} = require("../simple-page-ocr-runtime-config.cjs");

const OCR_REQUIREMENTS_LOCK_OVERRIDE_NAMES = [
  "MANGA_TRANSLATOR_OCR_REQUIREMENTS_LOCK",
  "MGT_OCR_REQUIREMENTS_LOCK",
];
const OCR_PACKAGE_OVERRIDE_NAMES = [
  "MANGA_TRANSLATOR_OCR_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_AMD_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_ROCM_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES",
  "MANGA_TRANSLATOR_OCR_GPU_PADDLE_WHEEL",
  "MANGA_TRANSLATOR_OCR_GPU_PADDLE_PACKAGE",
  "MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL",
  "MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL",
  "MANGA_TRANSLATOR_OCR_TORCH_INDEX_URL",
];

/**
 * Windows managed Python executes downloaded package code, so every built-in
 * package tree is installed from a generated, hash-complete lock. Custom
 * package/index overrides must supply their own lock instead of silently
 * downgrading the integrity boundary.
 *
 * @param {string[][]} installBatches
 * @param {RuntimeOptions} [options]
 * @returns {string[][]}
 */
function resolveIntegrityPinnedOcrInstallBatches(installBatches, options = {}) {
  if (process.platform !== "win32") {
    return installBatches;
  }
  const customLock = readFirstRuntimeOverride(
    OCR_REQUIREMENTS_LOCK_OVERRIDE_NAMES,
    options,
  );
  if (customLock) {
    const lockPath = path.resolve(customLock);
    if (!existsSync(lockPath)) {
      throw new Error(`OCR requirements lock을 찾지 못했습니다: ${lockPath}`);
    }
    return [buildHashedRequirementsBatch(lockPath, false)];
  }
  const customPackageOverride = OCR_PACKAGE_OVERRIDE_NAMES.find((name) =>
    Boolean(runtimeOverrideEnv(name, options)),
  );
  if (customPackageOverride) {
    throw new Error(
      `${customPackageOverride} override requires MGT_OCR_REQUIREMENTS_LOCK with a complete --require-hashes lock.`,
    );
  }

  return buildBuiltinIntegrityBatches(resolveOcrRuntimeVariant(options));
}

/** @param {string[]} names @param {RuntimeOptions} options @returns {string} */
function readFirstRuntimeOverride(names, options) {
  for (const name of names) {
    const value = String(runtimeOverrideEnv(name, options) ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** @param {string} variant @returns {string[][]} */
function buildBuiltinIntegrityBatches(variant) {
  const lockFile = resolveBuiltinOcrRequirementsLock(variant);
  return [
    buildHashedRequirementsBatch(
      path.join(__dirname, lockFile),
      variant !== "gpu-rocm-transformers",
      variant === "gpu-rocm-transformers",
    ),
  ];
}

/** @param {string} variant @returns {string} */
function resolveBuiltinOcrRequirementsLock(variant) {
  const locks = {
    cpu: "requirements-ocr-cpu-win-py312.lock",
    "gpu-cu126": "requirements-ocr-gpu-cu126-win-py312.lock",
    "gpu-cu129": "requirements-ocr-gpu-cu129-win-py312.lock",
    "gpu-cuda-transformers-cu126": "requirements-ocr-cuda-tf-cu126-win.lock",
    "gpu-cuda-transformers-cu130": "requirements-ocr-cuda-tf-cu130-win.lock",
    "gpu-rocm-transformers": "requirements-ocr-rocm-win-py312.lock",
  };
  const lockFile = /** @type {Record<string, string>} */ (locks)[variant];
  if (!lockFile) {
    throw new Error(
      `OCR runtime variant has no built-in integrity lock: ${variant}`,
    );
  }
  return lockFile;
}

/** @param {string} lockPath @param {boolean} onlyBinary @param {boolean} [noBuildIsolation] @returns {string[]} */
function buildHashedRequirementsBatch(
  lockPath,
  onlyBinary,
  noBuildIsolation = false,
) {
  return [
    "--require-hashes",
    ...(onlyBinary ? ["--only-binary=:all:"] : []),
    ...(noBuildIsolation ? ["--no-build-isolation"] : []),
    "--requirement",
    lockPath,
  ];
}

module.exports = { resolveIntegrityPinnedOcrInstallBatches };
