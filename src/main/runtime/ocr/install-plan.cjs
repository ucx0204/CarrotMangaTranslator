// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

const path = require("node:path");
const {
  AMD_ROCM_721_TORCH_DEP_PACKAGES,
  AMD_ROCM_721_TORCH_PACKAGES,
  DEFAULT_HAYAI_OCR_PACKAGES,
  DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
  DEFAULT_OCR_CPU_PIP_PACKAGES,
  DEFAULT_OCR_GPU_EXTRA_PACKAGES,
  DEFAULT_OCR_GPU_PADDLE_PACKAGE,
  resolveAmdRocmMetaPackage,
  resolveAmdRocmSdkWheelPackages,
} = require("../simple-page-defaults.cjs");
const { runtimeOverrideEnv } = require("./host-services.cjs");
const { splitShellLikeEnv } = require("./shell-words.cjs");
const {
  isHayaiOcrPipeline,
  isOcrCudaTorchRuntime,
  isOcrGpuRequested,
  isOcrTorchRuntime,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolvePaddleOcrGpuPackageIndexUrl,
  resolveOcrTorchCudaTag,
  resolveOcrTorchPackageIndexUrl,
  resolveOcrEngineLabel,
} = require("./runtime-device.cjs");

const DEFAULT_OCR_TRANSFORMERS_TOKENIZERS_PACKAGE = "tokenizers==0.23.0rc0";

/** @param {RuntimeOptions} [options] @returns {string[][]} */
function resolveOcrPipInstallBatches(options = {}) {
  if (isHayaiOcrPipeline(options)) {
    return resolveHayaiInstallBatches(options);
  }
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PIP_PACKAGES", options),
  );
  if (explicit.length > 0) {
    return wrapExplicitInstallBatch(explicit);
  }
  if (!isOcrGpuRequested(options)) {
    return isOcrTorchRuntime(options)
      ? resolveCpuTransformersInstallBatches(options)
      : resolveCpuInstallBatches(options);
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return resolveRocmInstallBatches(options);
  }
  if (isOcrCudaTorchRuntime(options)) {
    return resolveCudaTransformersInstallBatches(options);
  }
  return resolveCudaInstallBatches(options);
}

/** @param {RuntimeOptions} options @returns {string[][]} */
function resolveHayaiInstallBatches(options) {
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_HAYAI_OCR_PIP_PACKAGES", options),
  );
  if (explicit.length > 0) {
    return wrapExplicitInstallBatch(explicit);
  }
  if (!isOcrGpuRequested(options)) {
    const cpuOverride = splitShellLikeEnv(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_HAYAI_OCR_CPU_PIP_PACKAGES",
        options,
      ),
    );
    return cpuOverride.length > 0
      ? wrapExplicitInstallBatch(cpuOverride)
      : buildCpuTorchInstallBatches(options, DEFAULT_HAYAI_OCR_PACKAGES);
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    const rocmOverride = splitShellLikeEnv(
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_HAYAI_OCR_ROCM_PIP_PACKAGES",
        options,
      ),
    );
    return rocmOverride.length > 0
      ? wrapExplicitInstallBatch(rocmOverride)
      : buildRocmInstallBatches(options, DEFAULT_HAYAI_OCR_PACKAGES);
  }
  const cudaOverride = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_HAYAI_OCR_CUDA_PIP_PACKAGES", options),
  );
  return cudaOverride.length > 0
    ? wrapExplicitInstallBatch(cudaOverride)
    : buildCudaTorchInstallBatches(options, DEFAULT_HAYAI_OCR_PACKAGES);
}

/** @param {string[]} batch @returns {string[][]} */
function wrapExplicitInstallBatch(batch) {
  return [batch];
}

/** @param {RuntimeOptions} options @returns {string[][]} */
function resolveCpuInstallBatches(options) {
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES", options),
  );
  const packages =
    explicit.length > 0 ? explicit : DEFAULT_OCR_CPU_PIP_PACKAGES;
  return [packages];
}

/** @param {RuntimeOptions} options @returns {string[][]} */
function resolveCpuTransformersInstallBatches(options) {
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv(
      "MANGA_TRANSLATOR_OCR_CPU_TRANSFORMERS_PIP_PACKAGES",
      options,
    ),
  );
  if (explicit.length > 0) {
    return [explicit];
  }
  return buildCpuTorchInstallBatches(
    options,
    DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
  );
}

/** @param {RuntimeOptions} options @param {string[]} applicationPackages @returns {string[][]} */
function buildCpuTorchInstallBatches(options, applicationPackages) {
  const cpuTag = process.platform === "win32" ? "+cpu" : "";
  const torchPackages = [
    `torch==${resolvePinnedTorchBaseVersion("torch")}${cpuTag}`,
    `torchvision==${resolvePinnedTorchBaseVersion("torchvision")}${cpuTag}`,
  ];
  if (process.platform === "win32") {
    torchPackages.push("--index-url", "https://download.pytorch.org/whl/cpu");
  }
  return [
    AMD_ROCM_721_TORCH_DEP_PACKAGES,
    torchPackages,
    resolveTransformerApplicationPackages(applicationPackages),
  ];
}

/** @param {RuntimeOptions} options @returns {string[][]} */
function resolveRocmInstallBatches(options) {
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_AMD_PIP_PACKAGES", options) ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_ROCM_PIP_PACKAGES", options),
  );
  if (explicit.length > 0) {
    return [explicit];
  }
  return buildRocmInstallBatches(
    options,
    DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
  );
}

/** @param {RuntimeOptions} options @param {string[]} applicationPackages @returns {string[][]} */
function buildRocmInstallBatches(options, applicationPackages) {
  return [
    resolveAmdRocmSdkWheelPackages(options),
    resolveAmdRocmMetaPackage(options),
    AMD_ROCM_721_TORCH_DEP_PACKAGES,
    AMD_ROCM_721_TORCH_PACKAGES,
    resolveTransformerApplicationPackages(applicationPackages),
  ].filter((batch) => batch.length > 0);
}

/** @param {RuntimeOptions} options @returns {string[][]} */
function resolveCudaTransformersInstallBatches(options) {
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv(
      "MANGA_TRANSLATOR_OCR_CUDA_TRANSFORMERS_PIP_PACKAGES",
      options,
    ),
  );
  if (explicit.length > 0) {
    return [explicit];
  }
  return buildCudaTorchInstallBatches(
    options,
    DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
  );
}

/** @param {RuntimeOptions} options @param {string[]} applicationPackages @returns {string[][]} */
function buildCudaTorchInstallBatches(options, applicationPackages) {
  return [
    AMD_ROCM_721_TORCH_DEP_PACKAGES,
    resolveCudaTransformersTorchPackages(options),
    resolveTransformerApplicationPackages(applicationPackages),
  ];
}

/** @param {string[]} packages @returns {string[]} */
function resolveTransformerApplicationPackages(packages) {
  return packages.some((item) => /^tokenizers(?:[<>=~!]|$)/i.test(item))
    ? [...packages]
    : [...packages, DEFAULT_OCR_TRANSFORMERS_TOKENIZERS_PACKAGE];
}

/** @param {RuntimeOptions} options @returns {string[]} */
function resolveCudaTransformersTorchPackages(options) {
  const cudaTag = resolveOcrTorchCudaTag(options);
  return [
    `torch==${resolvePinnedTorchBaseVersion("torch")}+${cudaTag}`,
    `torchvision==${resolvePinnedTorchBaseVersion("torchvision")}+${cudaTag}`,
    "--index-url",
    resolveOcrTorchPackageIndexUrl(options),
  ];
}

/** @param {"torch" | "torchvision"} packageName @returns {string} */
function resolvePinnedTorchBaseVersion(packageName) {
  const pattern = new RegExp(
    `(?:^|/)${packageName}-([^/+]+)(?:%2B|\\+)rocm`,
    "i",
  );
  for (const packageUrl of AMD_ROCM_721_TORCH_PACKAGES) {
    const match = pattern.exec(String(packageUrl));
    if (match?.[1]) {
      return decodeURIComponent(match[1]);
    }
  }
  throw new Error(`Missing pinned ${packageName} version for OCR runtime.`);
}

/** @param {RuntimeOptions} options @returns {string[][]} */
function resolveCudaInstallBatches(options) {
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES", options),
  );
  const batches =
    explicit.length > 0
      ? [explicit]
      : [
          resolveOcrGpuPaddleInstallBatch(options),
          DEFAULT_OCR_GPU_EXTRA_PACKAGES,
        ];
  return batches;
}

/** @param {RuntimeOptions} options @returns {string[]} */
function resolveOcrGpuPaddleInstallBatch(options) {
  const explicitWheel = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_WHEEL", options) ?? "",
  ).trim();
  if (explicitWheel) {
    return [explicitWheel];
  }
  return [
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_PACKAGE", options) ||
      DEFAULT_OCR_GPU_PADDLE_PACKAGE,
    "--index-url",
    resolvePaddleOcrGpuPackageIndexUrl(options),
  ];
}

/** @param {unknown} installBatches @param {RuntimeOptions} [options] @returns {string} */
function summarizeOcrInstallBatches(installBatches, options = {}) {
  if (isHayaiOcrPipeline(options)) {
    return `HayaiOCR packages${resolveInstallSummarySuffix(options)}`;
  }
  const packageNames = (Array.isArray(installBatches) ? installBatches : [])
    .map((batch) => resolveOcrInstallBatchLabel(batch, options))
    .filter(Boolean);
  const suffix = resolveInstallSummarySuffix(options);
  return `${packageNames.join(", ") || `${resolveOcrEngineLabel(options)} packages`}${suffix}`;
}

/** @param {RuntimeOptions} options @returns {string} */
function resolveInstallSummarySuffix(options) {
  if (isHayaiOcrPipeline(options)) {
    if (!isOcrGpuRequested(options)) {
      return " (CPU)";
    }
    return resolveOcrGpuBackend(options) === "rocm-transformers"
      ? " (ROCm)"
      : ` (${resolveOcrTorchCudaTag(options)})`;
  }
  if (!isOcrGpuRequested(options)) {
    return isOcrTorchRuntime(options) ? " (cpu-transformers)" : "";
  }
  return resolveOcrGpuBackend(options) === "rocm-transformers"
    ? " (rocm-transformers)"
    : isOcrCudaTorchRuntime(options)
      ? " (cuda-transformers)"
      : ` (${resolveOcrGpuCudaTag(options)})`;
}

/** @param {unknown} packages @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrInstallBatchLabel(packages, options = {}) {
  const batch = Array.isArray(packages) ? packages : [];
  const packageText = batch.join(" ").toLowerCase();
  const cpuTransformersLabel =
    !isOcrGpuRequested(options) && isOcrTorchRuntime(options)
      ? resolveCpuTransformersInstallBatchLabel(packageText, options)
      : "";
  if (cpuTransformersLabel) {
    return cpuTransformersLabel;
  }
  const rocmLabel = isRocmInstall(options)
    ? resolveRocmInstallBatchLabel(packageText, options)
    : "";
  if (rocmLabel) {
    return rocmLabel;
  }
  const cudaTransformersLabel = isOcrCudaTorchRuntime(options)
    ? resolveCudaTransformersInstallBatchLabel(packageText, options)
    : "";
  if (cudaTransformersLabel) {
    return cudaTransformersLabel;
  }
  const packageNames = batch.filter(isNamedPackageArgument);
  return packageNames.length > 0
    ? packageNames.join(", ")
    : resolveUrlPackageNames(batch).join(", ");
}

/** @param {string} packageText @param {RuntimeOptions} options @returns {string} */
function resolveCpuTransformersInstallBatchLabel(packageText, options) {
  if (/torch==/.test(packageText) && /torchvision==/.test(packageText)) {
    return "PyTorch CPU wheels";
  }
  if (/transformers/.test(packageText) && /tokenizers/.test(packageText)) {
    return isHayaiOcrPipeline(options)
      ? "HayaiOCR packages"
      : "PaddleOCR Transformers packages";
  }
  return "";
}

/** @param {string} packageText @returns {string} */
function resolveCudaTransformersInstallBatchLabel(packageText, options = {}) {
  if (/torch==/.test(packageText) && /torchvision==/.test(packageText)) {
    return "PyTorch CUDA wheels";
  }
  if (/transformers/.test(packageText) && /tokenizers/.test(packageText)) {
    return isHayaiOcrPipeline(options)
      ? "HayaiOCR packages"
      : "PaddleOCR Transformers packages";
  }
  return "";
}

/** @param {RuntimeOptions} options @returns {boolean} */
function isRocmInstall(options) {
  return (
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  );
}

/** @param {string} packageText @returns {string} */
function resolveRocmInstallBatchLabel(packageText, options = {}) {
  /** @type {Array<[RegExp, string]>} */
  const classifiers = [
    [/rocm_sdk_/i, "AMD ROCm SDK wheels"],
    [
      /(?:^|[/\\])rocm-\d+(?:\.\d+)*\.tar\.gz(?:[?#].*)?$/i,
      "AMD ROCm meta package",
    ],
    [
      /(?=.*filelock)(?=.*typing-extensions)(?=.*sympy)/i,
      "PyTorch Python dependencies",
    ],
    [/(?=.*torch-)(?=.*rocm)/i, "PyTorch ROCm wheels"],
    [
      /(?=.*transformers)(?=.*tokenizers)/i,
      isHayaiOcrPipeline(options)
        ? "HayaiOCR packages"
        : "PaddleOCR Transformers packages",
    ],
  ];
  const match = classifiers.find(([pattern]) => pattern.test(packageText));
  return match ? String(match[1]) : "";
}

/** @param {string} part @returns {boolean} */
function isNamedPackageArgument(part) {
  return !part.startsWith("-") && !/^https?:\/\//i.test(part);
}

/** @param {string[]} batch @returns {string[]} */
function resolveUrlPackageNames(batch) {
  return batch
    .filter((part) => /^https?:\/\//i.test(part))
    .map(resolveUrlPackageName)
    .filter(Boolean);
}

/** @param {string} packageUrl @returns {string} */
function resolveUrlPackageName(packageUrl) {
  try {
    return path.basename(new URL(packageUrl).pathname) || "";
  } catch (_error) {
    return "";
  }
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrInstallSignature(options = {}) {
  return resolveOcrPipInstallBatches(options)
    .map((batch) => batch.join(" "))
    .join(" | ");
}

module.exports = {
  resolveOcrInstallBatchLabel,
  resolveOcrInstallSignature,
  resolveOcrPipInstallBatches,
  summarizeOcrInstallBatches,
};
