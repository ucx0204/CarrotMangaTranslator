// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

const path = require("node:path");
const {
  AMD_ROCM_721_TORCH_DEP_PACKAGES,
  AMD_ROCM_721_TORCH_PACKAGES,
  DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
  DEFAULT_OCR_CPU_PIP_PACKAGES,
  DEFAULT_OCR_GPU_EXTRA_PACKAGES,
  DEFAULT_OCR_GPU_PADDLE_PACKAGE,
  resolveAmdRocmMetaPackage,
  resolveAmdRocmSdkWheelPackages,
} = require("../simple-page-defaults.cjs");
const { runtimeOverrideEnv } = require("./host-services.cjs");
const {
  isOcrCudaTransformersRuntime,
  isOcrGpuRequested,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrTorchCudaTag,
  resolveOcrTorchPackageIndexUrl,
} = require("./runtime-device.cjs");

const DEFAULT_OCR_TRANSFORMERS_TOKENIZERS_PACKAGE = "tokenizers==0.23.0rc0";

/** @param {RuntimeOptions} [options] @returns {string[][]} */
function resolveOcrPipInstallBatches(options = {}) {
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PIP_PACKAGES", options),
  );
  if (explicit.length > 0) {
    return wrapExplicitInstallBatch(explicit);
  }
  if (!isOcrGpuRequested(options)) {
    return resolveCpuInstallBatches(options);
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return resolveRocmInstallBatches(options);
  }
  if (isOcrCudaTransformersRuntime(options)) {
    return resolveCudaTransformersInstallBatches(options);
  }
  return resolveCudaInstallBatches(options);
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
function resolveRocmInstallBatches(options) {
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_AMD_PIP_PACKAGES", options) ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_ROCM_PIP_PACKAGES", options),
  );
  if (explicit.length > 0) {
    return [explicit];
  }
  return [
    resolveAmdRocmSdkWheelPackages(options),
    resolveAmdRocmMetaPackage(options),
    AMD_ROCM_721_TORCH_DEP_PACKAGES,
    AMD_ROCM_721_TORCH_PACKAGES,
    [
      ...DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
      DEFAULT_OCR_TRANSFORMERS_TOKENIZERS_PACKAGE,
    ],
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
  return [
    AMD_ROCM_721_TORCH_DEP_PACKAGES,
    resolveCudaTransformersTorchPackages(options),
    [
      ...DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
      DEFAULT_OCR_TRANSFORMERS_TOKENIZERS_PACKAGE,
    ],
  ];
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
    resolveOcrGpuPackageIndexUrl(options),
  ];
}

/** @typedef {{ current: string; quote: string; escaped: boolean }} ShellTokenState */

/** @param {unknown} value @returns {string[]} */
function splitShellLikeEnv(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }
  /** @type {string[]} */
  const parts = [];
  /** @type {ShellTokenState} */
  const state = { current: "", quote: "", escaped: false };
  for (const char of raw) {
    consumeShellCharacter(state, parts, char);
  }
  if (state.escaped) {
    state.current += "\\";
  }
  pushShellToken(state, parts);
  return parts;
}

/** @param {ShellTokenState} state @param {string[]} parts @param {string} char */
function consumeShellCharacter(state, parts, char) {
  if (state.escaped) {
    state.current += char;
    state.escaped = false;
    return;
  }
  if (char === "\\") {
    state.escaped = true;
    return;
  }
  if (state.quote) {
    consumeQuotedCharacter(state, char);
    return;
  }
  if (char === '"' || char === "'") {
    state.quote = char;
    return;
  }
  if (/\s/.test(char)) {
    pushShellToken(state, parts);
    return;
  }
  state.current += char;
}

/** @param {ShellTokenState} state @param {string} char */
function consumeQuotedCharacter(state, char) {
  if (char === state.quote) {
    state.quote = "";
  } else {
    state.current += char;
  }
}

/** @param {ShellTokenState} state @param {string[]} parts */
function pushShellToken(state, parts) {
  if (state.current) {
    parts.push(state.current);
    state.current = "";
  }
}

/** @param {unknown} installBatches @param {RuntimeOptions} [options] @returns {string} */
function summarizeOcrInstallBatches(installBatches, options = {}) {
  const packageNames = (Array.isArray(installBatches) ? installBatches : [])
    .map((batch) => resolveOcrInstallBatchLabel(batch, options))
    .filter(Boolean);
  const suffix = resolveInstallSummarySuffix(options);
  return `${packageNames.join(", ") || "Paddle OCR packages"}${suffix}`;
}

/** @param {RuntimeOptions} options @returns {string} */
function resolveInstallSummarySuffix(options) {
  if (!isOcrGpuRequested(options)) {
    return "";
  }
  return resolveOcrGpuBackend(options) === "rocm-transformers"
    ? " (rocm-transformers)"
    : isOcrCudaTransformersRuntime(options)
      ? " (cuda-transformers)"
      : ` (${resolveOcrGpuCudaTag(options)})`;
}

/** @param {unknown} packages @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrInstallBatchLabel(packages, options = {}) {
  const batch = Array.isArray(packages) ? packages : [];
  const packageText = batch.join(" ").toLowerCase();
  const rocmLabel = isRocmInstall(options)
    ? resolveRocmInstallBatchLabel(packageText)
    : "";
  if (rocmLabel) {
    return rocmLabel;
  }
  const cudaTransformersLabel = isOcrCudaTransformersRuntime(options)
    ? resolveCudaTransformersInstallBatchLabel(packageText)
    : "";
  if (cudaTransformersLabel) {
    return cudaTransformersLabel;
  }
  const packageNames = batch.filter(isNamedPackageArgument);
  return packageNames.length > 0
    ? packageNames.join(", ")
    : resolveUrlPackageNames(batch).join(", ");
}

/** @param {string} packageText @returns {string} */
function resolveCudaTransformersInstallBatchLabel(packageText) {
  if (/torch==/.test(packageText) && /torchvision==/.test(packageText)) {
    return "PyTorch CUDA wheels";
  }
  if (/paddleocr/.test(packageText) && /transformers/.test(packageText)) {
    return "PaddleOCR Transformers packages";
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
function resolveRocmInstallBatchLabel(packageText) {
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
    [/(?=.*paddleocr)(?=.*transformers)/i, "PaddleOCR Transformers packages"],
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
