// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/**
 * @typedef {RuntimeOptions & {
 *   ocrDevice?: unknown;
 *   ocrGpuBackend?: unknown;
 *   ocrGpuCudaTag?: unknown;
 *   ocrRuntimeDir?: string | null;
 *   toolsDir?: string | null;
 *   workingDir?: string | null;
 *   [key: string]: unknown;
 * }} OcrConfigOptions
 */
const nodeCrypto = require("node:crypto");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  AMD_ROCM_721_TORCH_DEP_PACKAGES,
  AMD_ROCM_721_TORCH_PACKAGES,
  DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
  DEFAULT_OCR_CPU_PIP_PACKAGES,
  DEFAULT_OCR_GPU_CUDA_TAG,
  DEFAULT_OCR_GPU_EXTRA_PACKAGES,
  DEFAULT_OCR_GPU_PADDLE_PACKAGE,
  PADDLEOCR_VL_WINDOWS_SAFETENSORS_WHEEL,
  resolveAmdRocmMetaPackage,
  resolveAmdRocmSdkWheelPackages,
} = require("./simple-page-defaults.cjs");
const {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  buildWhitelistedChildEnv,
  isLikelyPackagedToolsDir,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides,
} = require("./simple-page-child-env.cjs");
const { resolveToolsDir } = require("./simple-page-runtime-paths.cjs");

const WINDOWS_LEGACY_MAX_PATH = 260;
const WINDOWS_PATH_SAFETY_MARGIN = 8;
const OCR_ROCM_WINDOWS_VERSION = "7.2.1";
const OCR_ROCM_LONGEST_LIBRARY_ENTRY = path.join(
  "_rocm_sdk_libraries_custom",
  "bin",
  "hipblaslt",
  "library",
  "TensileLibrary_B8B8_B8B8_HA_Bias_SAB_SCD_SAV_UA_Type_B8B8_HPA_Contraction_l_Ailk_Bjlk_Cijk_Dijk_gfx1200.co",
);
const OCR_ROCM_LONGEST_FINAL_ENTRY = path.join(
  "p",
  OCR_ROCM_LONGEST_LIBRARY_ENTRY,
);
const OCR_ROCM_LONGEST_PIP_TEMP_ENTRY = path.join(
  "t",
  "pip-target-xxxxxxxx",
  "lib",
  "python",
  OCR_ROCM_LONGEST_LIBRARY_ENTRY,
);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTruthy(value) {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(text);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function readPositiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @param {unknown} value
 * @param {number} [maxLength]
 * @returns {string}
 */
function truncateText(value, maxLength = 1200) {
  const text = String(value ?? "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}... [truncated ${text.length - maxLength} chars]`;
}

/**
 * @param {string} pythonPath
 * @returns {string}
 */
function resolveInstallProgressDir(pythonPath) {
  const resolved = path.resolve(String(pythonPath || ""));
  if (
    resolved.toLowerCase().endsWith(`${path.sep}scripts${path.sep}python.exe`)
  ) {
    return path.dirname(path.dirname(resolved));
  }
  return path.dirname(resolved);
}

/**
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolveOcrRuntimeDir(options = /** @type {OcrConfigOptions} */ ({})) {
  const explicitGlobal = runtimeOverrideEnv(
    "MANGA_TRANSLATOR_OCR_RUNTIME_DIR",
    options,
  );
  if (explicitGlobal && String(explicitGlobal).trim()) {
    return path.resolve(String(explicitGlobal).trim());
  }

  if (shouldUseWindowsShortRocmOcrLayout(options)) {
    return resolveWindowsRocmOcrRuntimeDir(options);
  }

  return path.resolve(
    String(
      options.ocrRuntimeDir ??
        path.join(options.workingDir || process.cwd(), "ocr-runtime"),
    ),
  );
}

function shouldUseWindowsShortRocmOcrLayout(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return (
    process.platform === "win32" &&
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  );
}

function resolveWindowsRocmOcrRuntimeDir(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const explicit =
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_ROCM_RUNTIME_DIR", options) ??
    runtimeOverrideEnv("MGT_OCR_ROCM_RUNTIME_DIR", options);
  if (explicit && String(explicit).trim()) {
    return path.resolve(String(explicit).trim());
  }

  const rocmDirName = `r${OCR_ROCM_WINDOWS_VERSION.replace(/\D/g, "")}`;
  const baseRuntimeDir = path.resolve(
    String(
      options.ocrRuntimeDir ??
        path.join(options.workingDir || process.cwd(), "ocr-runtime"),
    ),
  );
  const dataRoot = options.workingDir
    ? path.resolve(String(options.workingDir))
    : path.dirname(baseRuntimeDir);
  const dataRootCandidate = path.join(dataRoot, "or", rocmDirName);
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  const localCandidate = localAppData
    ? path.join(localAppData, "MGTOCR", rocmDirName)
    : null;
  const tmpCandidate = path.join(os.tmpdir(), "MGTOCR", rocmDirName);
  /** @type {string[]} */
  const candidates = [dataRootCandidate, tmpCandidate];
  if (localCandidate) {
    candidates.splice(1, 0, localCandidate);
  }
  const safeCandidate = candidates.find((candidate) =>
    isWindowsRocmOcrRuntimePathShortEnough(candidate),
  );
  return (
    safeCandidate ||
    candidates.sort((a, b) => a.length - b.length)[0] ||
    dataRootCandidate
  );
}

/**
 * @param {string} runtimeDir
 * @returns {boolean}
 */
function isWindowsRocmOcrRuntimePathShortEnough(runtimeDir) {
  const longestRuntimePath = Math.max(
    path.join(runtimeDir, OCR_ROCM_LONGEST_FINAL_ENTRY).length,
    path.join(runtimeDir, OCR_ROCM_LONGEST_PIP_TEMP_ENTRY).length,
  );
  return (
    longestRuntimePath < WINDOWS_LEGACY_MAX_PATH - WINDOWS_PATH_SAFETY_MARGIN
  );
}

/**
 * @param {string} runtimeDir
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolveOcrTempDir(
  runtimeDir,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return shouldUseWindowsShortRocmOcrLayout(options)
    ? path.join(runtimeDir, "t")
    : path.join(runtimeDir, "tmp");
}

/**
 * @param {string} runtimeDir
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolveOcrPipCacheDir(
  runtimeDir,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return shouldUseWindowsShortRocmOcrLayout(options)
    ? path.join(runtimeDir, "c")
    : path.join(runtimeDir, "pip-cache");
}

/**
 * @param {string} runtimeDir
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolveOcrPythonUserBaseDir(
  runtimeDir,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return shouldUseWindowsShortRocmOcrLayout(options)
    ? path.join(runtimeDir, "u")
    : path.join(runtimeDir, "python-user-base");
}

/**
 * @param {string} runtimeDir
 * @param {RuntimeOptions} [options]
 * @param {OcrRuntimeLayout | null} [runtime]
 * @returns {string}
 */
function resolvePaddlexCacheHome(
  runtimeDir,
  options = /** @type {OcrConfigOptions} */ ({}),
  runtime = null,
) {
  const explicit = runtimeOverrideEnv("PADDLE_PDX_CACHE_HOME", options);
  if (explicit) {
    return path.resolve(String(explicit));
  }
  if (runtime?.paddlexCacheHome) {
    return path.resolve(String(runtime.paddlexCacheHome));
  }
  const realCacheHome = resolveRealPaddlexCacheHome(runtimeDir);
  if (!hasNonAsciiPath(realCacheHome)) {
    return realCacheHome;
  }
  const digest = nodeCrypto
    .createHash("sha1")
    .update(realCacheHome)
    .digest("hex")
    .slice(0, 16);
  return path.join(
    resolvePaddlexCacheAliasRoot(options),
    digest,
    "paddlex-cache",
  );
}

/**
 * @param {string} runtimeDir
 * @returns {string}
 */
function resolveRealPaddlexCacheHome(runtimeDir) {
  return path.join(runtimeDir, "paddlex-cache");
}

/**
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolvePaddlexCacheAliasRoot(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const explicit = runtimeOverrideEnv(
    "MANGA_TRANSLATOR_OCR_CACHE_ALIAS_ROOT",
    options,
  );
  if (explicit) {
    return path.resolve(String(explicit));
  }
  const base = String(process.env.LOCALAPPDATA || os.tmpdir() || "").trim();
  return path.join(base || process.cwd(), "mgt-ocr-cache-links");
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasNonAsciiPath(value) {
  return /[^\x00-\x7f]/.test(String(value ?? ""));
}

/**
 * @param {string} venvDir
 * @returns {string}
 */
function resolveVenvPythonPath(venvDir) {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function resolveBootstrapPython(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const explicitCandidates = [
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PYTHON", options),
    runtimeOverrideEnv("MANGA_TRANSLATOR_PYTHON", options),
  ]
    .map((candidate) => String(candidate ?? "").trim())
    .filter(Boolean);

  for (const candidate of explicitCandidates) {
    if (candidate === "python" || existsSync(candidate)) {
      return candidate;
    }
  }

  const bundledCandidates = [
    path.join(options.toolsDir || "", "python", "python.exe"),
    path.join(options.toolsDir || "", "python", "python-embed", "python.exe"),
    path.join(options.toolsDir || "", "python.exe"),
  ];

  for (const candidate of bundledCandidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  if (shouldAllowSystemPythonFallback(options)) {
    return "python";
  }
  return null;
}

function shouldAllowSystemPythonFallback(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const explicit =
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_ALLOW_SYSTEM_PYTHON", options) ??
    runtimeOverrideEnv("MANGA_TRANSLATOR_ALLOW_SYSTEM_PYTHON", options);
  if (explicit !== undefined) {
    return isTruthy(explicit);
  }
  return !isLikelyPackagedToolsDir(options.toolsDir);
}

function resolveOcrPipInstallBatches(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const explicit = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PIP_PACKAGES", options),
  );
  if (explicit.length > 0) {
    return isOcrGpuRequested(options) &&
      resolveOcrGpuBackend(options) === "rocm-transformers"
      ? [explicit]
      : withPaddleOcrVlSafetensorsBatch([explicit]);
  }

  if (!isOcrGpuRequested(options)) {
    const cpuPackages = splitShellLikeEnv(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_CPU_PIP_PACKAGES", options),
    );
    return withPaddleOcrVlSafetensorsBatch([
      cpuPackages.length > 0 ? cpuPackages : DEFAULT_OCR_CPU_PIP_PACKAGES,
    ]);
  }

  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    const amdPackages = splitShellLikeEnv(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_AMD_PIP_PACKAGES", options) ??
        runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_ROCM_PIP_PACKAGES", options),
    );
    if (amdPackages.length > 0) {
      return [amdPackages];
    }
    return [
      resolveAmdRocmSdkWheelPackages(options),
      resolveAmdRocmMetaPackage(options),
      AMD_ROCM_721_TORCH_DEP_PACKAGES,
      AMD_ROCM_721_TORCH_PACKAGES,
      DEFAULT_OCR_AMD_TRANSFORMERS_PACKAGES,
    ].filter((batch) => batch.length > 0);
  }

  const gpuPackages = splitShellLikeEnv(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PIP_PACKAGES", options),
  );
  if (gpuPackages.length > 0) {
    return withPaddleOcrVlSafetensorsBatch([gpuPackages]);
  }

  return withPaddleOcrVlSafetensorsBatch([
    resolveOcrGpuPaddleInstallBatch(options),
    DEFAULT_OCR_GPU_EXTRA_PACKAGES,
  ]);
}

function resolveOcrGpuPaddleInstallBatch(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
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

/**
 * @param {unknown} installBatches
 * @returns {string[][]}
 */
function withPaddleOcrVlSafetensorsBatch(installBatches) {
  const batches = Array.isArray(installBatches)
    ? installBatches.map((batch) => (Array.isArray(batch) ? [...batch] : []))
    : [];
  if (process.platform !== "win32") {
    return batches;
  }

  /** @type {string[]} */
  const safetensorsPackages = [];
  const normalizedBatches = batches
    .map((batch) => {
      /** @type {string[]} */
      const normalPackages = [];
      for (const item of batch) {
        const text = String(item ?? "").trim();
        if (!text) {
          continue;
        }
        if (/safetensors/i.test(text)) {
          safetensorsPackages.push(text);
          continue;
        }
        normalPackages.push(text);
      }
      return normalPackages;
    })
    .filter((batch) => batch.length > 0);

  const safetensorsBatch = [
    "--no-deps",
    "--force-reinstall",
    ...(safetensorsPackages.length > 0
      ? safetensorsPackages
      : [PADDLEOCR_VL_WINDOWS_SAFETENSORS_WHEEL]),
  ];
  return [...normalizedBatches, safetensorsBatch];
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function splitShellLikeEnv(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }
  /** @type {string[]} */
  const parts = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += "\\";
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

/**
 * @param {unknown} installBatches
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function summarizeOcrInstallBatches(
  installBatches,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const packageNames = (Array.isArray(installBatches) ? installBatches : [])
    .map((batch) => resolveOcrInstallBatchLabel(batch, options))
    .filter(Boolean);
  let suffix = "";
  if (isOcrGpuRequested(options)) {
    suffix =
      resolveOcrGpuBackend(options) === "rocm-transformers"
        ? " (rocm-transformers)"
        : ` (${resolveOcrGpuCudaTag(options)})`;
  }
  return `${packageNames.join(", ") || "Paddle OCR packages"}${suffix}`;
}

/**
 * @param {unknown} packages
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolveOcrInstallBatchLabel(
  packages,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const batch = Array.isArray(packages) ? packages : [];
  const packageText = batch.join(" ").toLowerCase();
  if (
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  ) {
    if (packageText.includes("rocm_sdk_")) {
      return "AMD ROCm SDK wheels";
    }
    if (
      /(?:^|[/\\])rocm-\d+(?:\.\d+)*\.tar\.gz(?:[?#].*)?$/i.test(packageText)
    ) {
      return "AMD ROCm meta package";
    }
    if (
      packageText.includes("filelock") &&
      packageText.includes("typing-extensions") &&
      packageText.includes("sympy")
    ) {
      return "PyTorch Python dependencies";
    }
    if (packageText.includes("torch-") && packageText.includes("rocm")) {
      return "PyTorch ROCm wheels";
    }
    if (
      packageText.includes("paddleocr") &&
      packageText.includes("transformers")
    ) {
      return "PaddleOCR Transformers packages";
    }
  }

  const packageNames = batch.filter(
    (part) => !part.startsWith("-") && !/^https?:\/\//i.test(part),
  );
  if (packageNames.length > 0) {
    return packageNames.join(", ");
  }

  const urlNames = batch
    .filter((part) => /^https?:\/\//i.test(part))
    .map((part) => {
      try {
        return path.basename(new URL(part).pathname) || "";
      } catch (_error) {
        return "";
      }
    })
    .filter(Boolean);
  return urlNames.join(", ");
}

function isOcrGpuRequested(options = /** @type {OcrConfigOptions} */ ({})) {
  return resolveOcrDevice(options).startsWith("gpu");
}

function isOcrBlackwellCudaTag(options = /** @type {OcrConfigOptions} */ ({})) {
  return (
    resolveOcrGpuBackend(options) === "cuda" &&
    resolveOcrGpuCudaTag(options) === "cu129"
  );
}

function resolveOcrGpuBackend(options = /** @type {OcrConfigOptions} */ ({})) {
  const normalized = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_BACKEND", options) ??
      options.ocrGpuBackend ??
      "cuda",
  )
    .trim()
    .toLowerCase();
  if (normalized === "cuda" || normalized === "nvidia") {
    return "cuda";
  }
  if (
    normalized === "rocm" ||
    normalized === "amd" ||
    normalized === "hip" ||
    normalized === "rocm-transformers" ||
    normalized === "transformers-rocm"
  ) {
    return "rocm-transformers";
  }
  return "cuda";
}

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

function resolveOcrGpuPackageIndexUrl(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_GPU_PADDLE_INDEX_URL", options) ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_GPU_INDEX_URL", options) ??
      `https://www.paddlepaddle.org.cn/packages/stable/${resolveOcrGpuCudaTag(options)}/`,
  ).trim();
}

function resolveOcrRuntimeVariant(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
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

/**
 * @param {string} runtimeDir
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolveOcrPythonPackageDir(
  runtimeDir,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  if (shouldUseWindowsShortRocmOcrLayout(options)) {
    return path.join(runtimeDir, "p");
  }

  return path.join(
    runtimeDir,
    `python-packages-${resolveOcrRuntimeVariant(options)}`,
  );
}

/**
 * @param {string} runtimeDir
 * @param {string} runtimeVariant
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolveOcrVenvDir(
  runtimeDir,
  runtimeVariant,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  if (shouldUseWindowsShortRocmOcrLayout(options)) {
    return path.join(runtimeDir, "v");
  }
  return path.join(runtimeDir, `.venv-${runtimeVariant}`);
}

function resolveOcrDevice(options = /** @type {OcrConfigOptions} */ ({})) {
  const explicitDevice = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_DEVICE", options) ?? "",
  ).trim();
  if (explicitDevice) {
    return explicitDevice;
  }
  const value = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options) ??
      options.ocrDevice ??
      "cpu",
  )
    .trim()
    .toLowerCase();
  if (value === "gpu" || value === "cuda") {
    return "gpu:0";
  }
  if (value.startsWith("gpu")) {
    return value;
  }
  return "cpu";
}

function resolveOcrDeviceLabel(options = /** @type {OcrConfigOptions} */ ({})) {
  const device = resolveOcrDevice(options);
  return device === "cpu" ? "CPU" : device.toUpperCase();
}

function resolvePaddleOcrImportCheckTimeoutMs(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const explicit = readPositiveInteger(
    process.env.MANGA_TRANSLATOR_OCR_IMPORT_TIMEOUT_MS,
  );
  if (explicit) {
    return explicit;
  }
  if (isOcrGpuRequested(options)) {
    if (resolveOcrGpuBackend(options) === "rocm-transformers") {
      return 300000;
    }
    return isOcrBlackwellCudaTag(options) ? 300000 : 180000;
  }
  return 120000;
}

/**
 * @param {unknown} importMessage
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function buildPaddleOcrImportFailureMessage(
  importMessage,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  if (
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  ) {
    const detail = importMessage
      ? ` detail=${truncateText(importMessage, 1200)}`
      : "";
    if (isPaddleOcrVerificationTimeoutText(importMessage)) {
      return `Paddle OCR 런타임 설치 후 AMD ROCm/PyTorch 검증이 시간 초과되었습니다. Windows ROCm PyTorch 첫 import가 오래 걸릴 수 있습니다.${detail}`;
    }
    return `AMD OCR GPU 실행에 실패했습니다. AMD 경로는 PaddlePaddle CUDA가 아니라 Windows ROCm PyTorch + PaddleOCR Transformers engine을 사용합니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1이 지원하는 GPU와 드라이버가 필요합니다. 실패가 반복되면 AMD ROCm OCR 안전 모드(dtype=float32, MIOpen 비활성화, det limit=1600)가 적용됐는지 확인하세요.${detail}`;
  }
  if (isPaddleSm120UnsupportedText(importMessage)) {
    return buildPaddleOcrSm120FailureMessage(importMessage, options);
  }
  if (isPaddleBfloat16SafetensorsText(importMessage)) {
    return buildPaddleOcrBfloat16SafetensorsFailureMessage(
      importMessage,
      options,
    );
  }
  if (isPaddleNativeDllLoadFailureText(importMessage)) {
    return buildPaddleOcrNativeDllFailureMessage(importMessage, options);
  }
  if (isPaddleOcrVerificationTimeoutText(importMessage)) {
    const suffix = resolvePaddleOcrTimeoutSuffix(options);
    return `Paddle OCR 런타임 설치 후 검증이 시간 초과되었습니다.${suffix} detail=${truncateText(importMessage, 1200)}`;
  }
  const suffix = isOcrGpuRequested(options)
    ? " GPU를 선택했지만 GPU Paddle/CUDA 검증에 실패했습니다. CPU로 바꾸거나 CUDA 드라이버와 GPU Paddle wheel을 확인하세요."
    : "";
  const detail = importMessage
    ? ` detail=${truncateText(importMessage, 1200)}`
    : "";
  return `PaddleOCR-VL runtime was installed but paddleocr/paddlex/paddle imports still fail.${suffix}${detail}`;
}

function resolvePaddleOcrTimeoutSuffix(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  if (!isOcrGpuRequested(options)) {
    return " CPU 런타임 검증이 제한 시간 안에 끝나지 않았습니다.";
  }
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return " AMD ROCm/PyTorch GPU 검증이 제한 시간 안에 끝나지 않았습니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1 지원 GPU와 드라이버를 확인하세요.";
  }
  return ` CUDA GPU 검증이 제한 시간 안에 끝나지 않았습니다. RTX 50번대는 cu129 런타임을 사용하며 첫 실행 검증이 오래 걸릴 수 있지만, 반복되면 NVIDIA 드라이버/CUDA 12.9용 Paddle 런타임 호환성을 확인해야 합니다.`;
}

/**
 * @param {unknown} error
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function buildPaddleOcrGpuFailureMessage(
  error,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const text = summarizeOcrErrorMessage(error);
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return `AMD OCR GPU 실행에 실패했습니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1이 지원하는 GPU와 Python 3.12가 필요합니다. AMD ROCm 지원 GPU/드라이버와 OCR 안전 모드 설정을 확인하세요. detail=${truncateText(text, 1200)}`;
  }
  if (isPaddleSm120UnsupportedText(text)) {
    return buildPaddleOcrSm120FailureMessage(text, options);
  }
  if (isPaddleBfloat16SafetensorsText(text)) {
    return buildPaddleOcrBfloat16SafetensorsFailureMessage(text, options);
  }
  return `Paddle OCR GPU 실행에 실패했습니다. GPU 설정을 쓰려면 CUDA가 보이는 NVIDIA GPU Paddle 런타임이 필요합니다. OCR 장치를 CPU로 바꾸거나 NVIDIA 드라이버/CUDA용 Paddle 런타임을 확인하세요. detail=${truncateText(text, 1200)}`;
}

/**
 * @param {unknown} detail
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function buildPaddleOcrSm120FailureMessage(
  detail,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return `RTX 50번대/SM120에서 현재 Paddle OCR GPU 런타임이 맞지 않습니다. RTX 50번대는 CUDA 12.9용 Paddle OCR 런타임(cu129)을 사용해야 합니다. 설정값은 현재 ${resolveOcrGpuCudaTag(options)}입니다. 기존 gpu-cu126 런타임이 남아 있으면 OCR 런타임을 삭제하고 다시 시도하세요. detail=${truncateText(detail, 1200)}`;
}

/**
 * @param {unknown} detail
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function buildPaddleOcrBfloat16SafetensorsFailureMessage(
  detail,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return `PaddleOCR-VL 모델 가중치(bfloat16)를 현재 OCR 런타임이 읽지 못했습니다. Windows에서는 PaddleOCR-VL용 special safetensors 휠과 공식 ${resolveOcrGpuCudaTag(options)} Paddle 런타임이 같이 필요합니다. OCR 런타임 패키지가 다시 설치되도록 앱을 업데이트한 뒤 재시도하세요. detail=${truncateText(detail, 1200)}`;
}

/**
 * @param {unknown} detail
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function buildPaddleOcrNativeDllFailureMessage(
  detail,
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  if (
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  ) {
    return `AMD OCR GPU 런타임의 Windows ROCm PyTorch DLL을 불러오지 못했습니다. Windows ROCm PyTorch 2.9.1/ROCm 7.2.1 지원 GPU/드라이버와 OCR 런타임 설치 상태와 AMD ROCm OCR 안전 모드 설정을 확인하세요. detail=${truncateText(detail, 1200)}`;
  }
  const runtimeLabel = isOcrGpuRequested(options) ? "GPU" : "CPU";
  return `Paddle OCR ${runtimeLabel} 런타임의 네이티브 DLL을 불러오지 못했습니다. 앱이 Paddle 패키지 내부 DLL 경로를 다시 잡도록 수정했지만, 같은 오류가 반복되면 OCR 런타임을 삭제하고 재설치하거나 Microsoft Visual C++ 2015-2022 재배포 패키지가 설치되어 있는지 확인하세요. detail=${truncateText(detail, 1200)}`;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPaddleSm120UnsupportedText(value) {
  return /not compiled for\s+SM\s*120|sm[_\s-]*120|compute capability:\s*12(?:\.0)?|mismatched gpu architecture/i.test(
    String(value ?? ""),
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPaddleBfloat16SafetensorsText(value) {
  return /data type ['"]?bfloat16['"]? not understood|_load_part_state_dict_from_safetensors/i.test(
    String(value ?? ""),
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPaddleNativeDllLoadFailureText(value) {
  return /can not import paddle core|libpaddle\.pyd|dll load failed while importing libpaddle|the specified module could not be found/i.test(
    String(value ?? ""),
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPaddleOcrVerificationTimeoutText(value) {
  return /Paddle OCR runtime verification timed out|OCR bbox command timed out/i.test(
    String(value ?? ""),
  );
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function summarizeOcrErrorMessage(error) {
  if (!error || typeof error !== "object") {
    return String(error ?? "");
  }
  const summary =
    /** @type {{ message?: unknown; stderrPreview?: unknown; stdoutPreview?: unknown; cause?: unknown }} */ (
      error
    );
  const parts = [
    summary.message,
    summary.stderrPreview,
    summary.stdoutPreview,
    summary.cause instanceof Error ? summary.cause.message : summary.cause,
  ].filter(Boolean);
  return parts.length > 0
    ? parts.map((part) => String(part)).join(" ")
    : String(error);
}

function resolveOcrInstallSignature(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  return resolveOcrPipInstallBatches(options)
    .map((batch) => batch.join(" "))
    .join(" | ");
}

function buildPaddleOcrImportCheckScript(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const device = resolveOcrDevice(options);
  if (
    device.startsWith("gpu") &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  ) {
    return [
      "import os",
      "_dll_dirs = [p for p in os.environ.get('MANGA_TRANSLATOR_OCR_DLL_DIRS', '').split(os.pathsep) if p]",
      "_dll_handles = [os.add_dll_directory(p) for p in _dll_dirs if hasattr(os, 'add_dll_directory') and os.path.isdir(p)]",
      "import importlib.util",
      "missing = [name for name in ('torch', 'transformers', 'paddleocr') if importlib.util.find_spec(name) is None]",
      "assert not missing, 'Missing AMD ROCm OCR package(s): ' + ', '.join(missing)",
      "import torch",
      "assert torch.cuda.is_available(), 'AMD ROCm PyTorch GPU is not available'",
      "assert getattr(torch.version, 'hip', None), 'PyTorch is not a ROCm/HIP build'",
      "x = torch.ones((1,), device='cuda')",
      "torch.cuda.synchronize()",
      "print('torch', torch.__version__)",
      "print('hip', torch.version.hip)",
      "print('gpu', torch.cuda.get_device_name(0))",
      "from paddleocr import PaddleOCR",
    ].join("; ");
  }

  const lines = [
    "import os",
    "_dll_dirs = [p for p in os.environ.get('MANGA_TRANSLATOR_OCR_DLL_DIRS', '').split(os.pathsep) if p]",
    "_dll_handles = [os.add_dll_directory(p) for p in _dll_dirs if hasattr(os, 'add_dll_directory') and os.path.isdir(p)]",
    "import importlib.util",
    "missing = [name for name in ('paddle', 'paddlex', 'paddleocr') if importlib.util.find_spec(name) is None]",
    "assert not missing, 'Missing Paddle OCR package(s): ' + ', '.join(missing)",
    "import paddle",
    "from paddleocr import PaddleOCRVL, PaddleOCR",
  ];
  if (device.startsWith("gpu")) {
    lines.push(
      "assert paddle.device.is_compiled_with_cuda(), 'PaddlePaddle is not compiled with CUDA'",
    );
    lines.push("count = paddle.device.cuda.device_count()");
    lines.push("assert count > 0, 'No CUDA device is visible to PaddlePaddle'");
    lines.push(`paddle.set_device(${JSON.stringify(device)})`);
  }
  return lines.join("; ");
}

/**
 * @param {RuntimeOptions} [options]
 * @param {OcrRuntimeLayout | null} [runtime]
 * @returns {NodeJS.ProcessEnv}
 */
function buildOcrRuntimeEnv(
  options = /** @type {OcrConfigOptions} */ ({}),
  runtime = null,
) {
  const runtimeDir = runtime?.runtimeDir || resolveOcrRuntimeDir(options);
  const hfHomeDir =
    options.hfHomeDir ||
    runtimeOverrideEnv("HF_HOME", options) ||
    (shouldUseWindowsShortRocmOcrLayout(options)
      ? path.join(runtimeDir, "h")
      : path.join(runtimeDir, "hf-cache"));
  const hfHubCacheDir =
    options.hfHubCacheDir ||
    runtimeOverrideEnv("HF_HUB_CACHE", options) ||
    runtimeOverrideEnv("HUGGINGFACE_HUB_CACHE", options) ||
    path.join(hfHomeDir, "hub");
  const packageDir =
    runtime?.packageDir || resolveOcrPythonPackageDir(runtimeDir, options);
  const includePackageDir =
    runtime?.includePackageDir ?? runtime?.usesTargetPackageDir ?? true;
  const pythonPath = includePackageDir ? packageDir : "";
  const dllSearchDirs = buildOcrRuntimeDllSearchDirs(
    options,
    runtime,
    runtimeDir,
  );
  const ocrDevice = resolveOcrDevice(options);
  const ocrGpuBackend = resolveOcrGpuBackend(options);
  const pipCacheDir = resolveOcrPipCacheDir(runtimeDir, options);
  const tempDir = resolveOcrTempDir(runtimeDir, options);
  const pythonUserBase = resolveOcrPythonUserBaseDir(runtimeDir, options);
  const env = buildWhitelistedChildEnv({
    pathDirs: buildOcrRuntimePathDirs(options, runtime, runtimeDir),
    includeProcessPath: shouldAllowExternalRuntimeOverrides(options),
    extraKeys: [...NETWORK_CHILD_ENV_KEYS, ...HF_CHILD_ENV_KEYS],
  });
  return {
    ...env,
    HF_HOME: hfHomeDir,
    HF_HUB_CACHE: hfHubCacheDir,
    HUGGINGFACE_HUB_CACHE: hfHubCacheDir,
    HF_HUB_DISABLE_XET:
      runtimeOverrideEnv("HF_HUB_DISABLE_XET", options) || "1",
    HF_HUB_ETAG_TIMEOUT:
      runtimeOverrideEnv("HF_HUB_ETAG_TIMEOUT", options) || "30",
    HF_HUB_DOWNLOAD_TIMEOUT:
      runtimeOverrideEnv("HF_HUB_DOWNLOAD_TIMEOUT", options) || "300",
    MANGA_TRANSLATOR_OCR_DEVICE:
      options.ocrDevice ||
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options) ||
      "cpu",
    MANGA_TRANSLATOR_OCR_GPU_BACKEND: ocrGpuBackend,
    MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG: resolveOcrGpuCudaTag(options),
    MANGA_TRANSLATOR_OCR_DLL_DIRS: dllSearchDirs.join(path.delimiter),
    MANGA_TRANSLATOR_PADDLEOCR_DEVICE: ocrDevice,
    ...(ocrGpuBackend === "rocm-transformers" && ocrDevice.startsWith("gpu")
      ? {
          MANGA_TRANSLATOR_PADDLEOCR_ENGINE:
            runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_ENGINE", options) ||
            "transformers",
          MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE:
            runtimeOverrideEnv(
              "MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE",
              options,
            ) || "float32",
          MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE:
            runtimeOverrideEnv(
              "MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE",
              options,
            ) || "ocr",
          MANGA_TRANSLATOR_PADDLEOCR_VERSION:
            runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_VERSION", options) ||
            "PP-OCRv6",
          MANGA_TRANSLATOR_PADDLEOCR_ATTN:
            runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_ATTN", options) ||
            "eager",
          MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE:
            runtimeOverrideEnv(
              "MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE",
              options,
            ) || "conservative",
          MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN:
            runtimeOverrideEnv(
              "MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN",
              options,
            ) || "1",
          MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT:
            runtimeOverrideEnv(
              "MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT",
              options,
            ) || "1600",
          MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH:
            runtimeOverrideEnv(
              "MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH",
              options,
            ) || "1",
        }
      : {}),
    PYTHONPATH: pythonPath,
    PYTHONNOUSERSITE: "1",
    PYTHONUSERBASE: pythonUserBase,
    PIP_CACHE_DIR: pipCacheDir,
    PADDLE_PDX_MODEL_SOURCE:
      runtimeOverrideEnv("PADDLE_PDX_MODEL_SOURCE", options) || "huggingface",
    PADDLE_PDX_CACHE_HOME: resolvePaddlexCacheHome(
      runtimeDir,
      options,
      runtime,
    ),
    PADDLE_PDX_HUGGING_FACE_ENDPOINT:
      runtimeOverrideEnv("PADDLE_PDX_HUGGING_FACE_ENDPOINT", options) ||
      "https://huggingface.co",
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK:
      runtimeOverrideEnv("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", options) ||
      "True",
    PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT:
      runtimeOverrideEnv("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", options) || "0",
    PIP_DISABLE_PIP_VERSION_CHECK:
      runtimeOverrideEnv("PIP_DISABLE_PIP_VERSION_CHECK", options) || "1",
    TMP: tempDir,
    TEMP: tempDir,
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
  };
}

/**
 * @param {RuntimeOptions} [options]
 * @param {OcrRuntimeLayout | null} [runtime]
 * @param {string} [runtimeDir]
 * @returns {Array<string | null | undefined>}
 */
function buildOcrRuntimePathDirs(
  options = /** @type {OcrConfigOptions} */ ({}),
  runtime = null,
  runtimeDir = resolveOcrRuntimeDir(options),
) {
  const variant = resolveOcrRuntimeVariant(options);
  const venvDir = resolveOcrVenvDir(runtimeDir, variant, options);
  const venvBinDir =
    process.platform === "win32"
      ? path.join(venvDir, "Scripts")
      : path.join(venvDir, "bin");
  const toolsDir = resolveToolsDir(options);
  const dirs = [
    runtime?.pythonPath ? path.dirname(runtime.pythonPath) : null,
    venvBinDir,
    ...buildOcrRuntimeDllSearchDirs(options, runtime, runtimeDir),
    path.join(toolsDir || "", "python"),
    path.join(toolsDir || "", "python", "python-embed"),
    runtimeDir,
  ];
  return dirs;
}

/**
 * @param {RuntimeOptions} [options]
 * @param {OcrRuntimeLayout | null} [runtime]
 * @param {string} [runtimeDir]
 * @returns {string[]}
 */
function buildOcrRuntimeDllSearchDirs(
  options = /** @type {OcrConfigOptions} */ ({}),
  runtime = null,
  runtimeDir = resolveOcrRuntimeDir(options),
) {
  const packageDir =
    runtime?.packageDir || resolveOcrPythonPackageDir(runtimeDir, options);
  const paddleDirs = [
    packageDir,
    path.join(packageDir, "paddle"),
    path.join(packageDir, "paddle", "base"),
    path.join(packageDir, "paddle", "base", "libs"),
    path.join(packageDir, "paddle", "libs"),
    path.join(packageDir, "paddle.libs"),
    path.join(packageDir, "Paddle.libs"),
  ];
  if (resolveOcrGpuBackend(options) !== "rocm-transformers") {
    return paddleDirs;
  }
  return [
    ...paddleDirs,
    path.join(packageDir, "Scripts"),
    path.join(packageDir, "torch"),
    path.join(packageDir, "torch", "lib"),
    path.join(packageDir, "rocm"),
    path.join(packageDir, "rocm", "bin"),
    path.join(packageDir, "rocm", "lib"),
    path.join(packageDir, "rocm_sdk"),
    path.join(packageDir, "rocm_sdk", "bin"),
    path.join(packageDir, "_rocm_sdk_core"),
    path.join(packageDir, "_rocm_sdk_core", "bin"),
    path.join(packageDir, "_rocm_sdk_core", "lib", "llvm", "bin"),
    path.join(packageDir, "_rocm_sdk_devel"),
    path.join(packageDir, "_rocm_sdk_devel", "bin"),
    path.join(packageDir, "_rocm_sdk_devel", "lib", "llvm", "bin"),
    path.join(packageDir, "_rocm_sdk_libraries_custom"),
    path.join(packageDir, "_rocm_sdk_libraries_custom", "bin"),
    path.join(packageDir, "_rocm_sdk_libraries_custom", "bin", "hipblaslt"),
    path.join(
      packageDir,
      "_rocm_sdk_libraries_custom",
      "bin",
      "hipblaslt",
      "library",
    ),
  ];
}

module.exports = {
  OCR_ROCM_LONGEST_FINAL_ENTRY,
  OCR_ROCM_LONGEST_LIBRARY_ENTRY,
  OCR_ROCM_LONGEST_PIP_TEMP_ENTRY,
  OCR_ROCM_WINDOWS_VERSION,
  WINDOWS_LEGACY_MAX_PATH,
  WINDOWS_PATH_SAFETY_MARGIN,
  buildOcrRuntimeEnv,
  buildPaddleOcrGpuFailureMessage,
  buildPaddleOcrImportCheckScript,
  buildPaddleOcrImportFailureMessage,
  hasNonAsciiPath,
  isOcrGpuRequested,
  isPaddleBfloat16SafetensorsText,
  isPaddleNativeDllLoadFailureText,
  isPaddleSm120UnsupportedText,
  isWindowsRocmOcrRuntimePathShortEnough,
  resolveBootstrapPython,
  resolveInstallProgressDir,
  resolveOcrDevice,
  resolveOcrDeviceLabel,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrGpuPackageIndexUrl,
  resolveOcrInstallSignature,
  resolveOcrInstallBatchLabel,
  resolveOcrPipInstallBatches,
  resolveOcrPipCacheDir,
  resolveOcrPythonPackageDir,
  resolveOcrPythonUserBaseDir,
  resolveOcrRuntimeDir,
  resolveOcrRuntimeVariant,
  resolveOcrTempDir,
  resolveOcrVenvDir,
  resolvePaddlexCacheAliasRoot,
  resolvePaddlexCacheHome,
  resolvePaddleOcrImportCheckTimeoutMs,
  resolveRealPaddlexCacheHome,
  resolveVenvPythonPath,
  shouldAllowSystemPythonFallback,
  shouldUseWindowsShortRocmOcrLayout,
  summarizeOcrInstallBatches,
  summarizeOcrErrorMessage,
};
