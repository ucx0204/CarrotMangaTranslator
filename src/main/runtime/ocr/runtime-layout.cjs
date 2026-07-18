// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/**
 * @typedef {RuntimeOptions & {
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
  isLikelyPackagedToolsDir,
  runtimeOverrideEnv,
} = require("./host-services.cjs");
const { isTruthy } = require("./config-values.cjs");
const {
  isOcrGpuRequested,
  resolveOcrGpuBackend,
  resolveOcrRuntimeVariant,
} = require("./runtime-device.cjs");

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

/** @param {string} pythonPath @returns {string} */
function resolveInstallProgressDir(pythonPath) {
  const resolved = path.resolve(String(pythonPath || ""));
  const venvSuffix = `${path.sep}scripts${path.sep}python.exe`;
  return resolved.toLowerCase().endsWith(venvSuffix)
    ? path.dirname(path.dirname(resolved))
    : path.dirname(resolved);
}

/** @param {RuntimeOptions} [options] @returns {string} */
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
  return resolveDefaultOcrRuntimeDir(options);
}

/** @param {OcrConfigOptions} options @returns {string} */
function resolveDefaultOcrRuntimeDir(options) {
  return path.resolve(
    String(
      options.ocrRuntimeDir ??
        path.join(options.workingDir || process.cwd(), "ocr-runtime"),
    ),
  );
}

/** @param {RuntimeOptions} [options] @returns {boolean} */
function shouldUseWindowsShortRocmOcrLayout(options = {}) {
  return (
    process.platform === "win32" &&
    isOcrGpuRequested(options) &&
    resolveOcrGpuBackend(options) === "rocm-transformers"
  );
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveWindowsRocmOcrRuntimeDir(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const explicit = resolveExplicitWindowsRocmDir(options);
  if (explicit) {
    return explicit;
  }
  const candidates = buildWindowsRocmDirCandidates(options);
  const safeCandidate = candidates.find(isWindowsRocmOcrRuntimePathShortEnough);
  return safeCandidate || pickShortestPath(candidates);
}

/** @param {OcrConfigOptions} options @returns {string | null} */
function resolveExplicitWindowsRocmDir(options) {
  const explicit =
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_ROCM_RUNTIME_DIR", options) ??
    runtimeOverrideEnv("MGT_OCR_ROCM_RUNTIME_DIR", options);
  const normalized = String(explicit ?? "").trim();
  return normalized ? path.resolve(normalized) : null;
}

/** @param {OcrConfigOptions} options @returns {string[]} */
function buildWindowsRocmDirCandidates(options) {
  const rocmDirName = `r${OCR_ROCM_WINDOWS_VERSION.replace(/\D/g, "")}`;
  const baseRuntimeDir = resolveDefaultOcrRuntimeDir(options);
  const dataRoot = options.workingDir
    ? path.resolve(String(options.workingDir))
    : path.dirname(baseRuntimeDir);
  const candidates = [
    path.join(dataRoot, "or", rocmDirName),
    path.join(os.tmpdir(), "MGTOCR", rocmDirName),
  ];
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();
  if (localAppData) {
    candidates.splice(1, 0, path.join(localAppData, "MGTOCR", rocmDirName));
  }
  return candidates;
}

/** @param {string[]} candidates @returns {string} */
function pickShortestPath(candidates) {
  return [...candidates].sort((a, b) => a.length - b.length)[0];
}

/** @param {string} runtimeDir @returns {boolean} */
function isWindowsRocmOcrRuntimePathShortEnough(runtimeDir) {
  const longestRuntimePath = Math.max(
    path.join(runtimeDir, OCR_ROCM_LONGEST_FINAL_ENTRY).length,
    path.join(runtimeDir, OCR_ROCM_LONGEST_PIP_TEMP_ENTRY).length,
  );
  return (
    longestRuntimePath < WINDOWS_LEGACY_MAX_PATH - WINDOWS_PATH_SAFETY_MARGIN
  );
}

/** @param {string} runtimeDir @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrTempDir(runtimeDir, options = {}) {
  return shouldUseWindowsShortRocmOcrLayout(options)
    ? path.join(runtimeDir, "t")
    : path.join(runtimeDir, "tmp");
}

/** @param {string} runtimeDir @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrPipCacheDir(runtimeDir, options = {}) {
  return shouldUseWindowsShortRocmOcrLayout(options)
    ? path.join(runtimeDir, "c")
    : path.join(runtimeDir, "pip-cache");
}

/** @param {string} runtimeDir @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrPythonUserBaseDir(runtimeDir, options = {}) {
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
function resolvePaddlexCacheHome(runtimeDir, options = {}, runtime = null) {
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

/** @param {string} runtimeDir @returns {string} */
function resolveRealPaddlexCacheHome(runtimeDir) {
  return path.join(runtimeDir, "paddlex-cache");
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolvePaddlexCacheAliasRoot(options = {}) {
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

/** @param {unknown} value @returns {boolean} */
function hasNonAsciiPath(value) {
  return /[^\x00-\x7f]/.test(String(value ?? ""));
}

/** @param {string} venvDir @returns {string} */
function resolveVenvPythonPath(venvDir) {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/** @param {RuntimeOptions} [options] @returns {string | null} */
function resolveBootstrapPython(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const explicit = findAvailablePython(
    [
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_PYTHON", options),
      runtimeOverrideEnv("MANGA_TRANSLATOR_PYTHON", options),
    ].map((candidate) => String(candidate ?? "").trim()),
  );
  if (explicit) {
    return explicit;
  }
  const bundled = findAvailablePython(
    process.platform === "darwin"
      ? [
          path.join(options.toolsDir || "", "python", "bin", "python3"),
          path.join(options.toolsDir || "", "python", "bin", "python3.12"),
          path.join(options.toolsDir || "", "python", "bin", "python"),
        ]
      : [
          path.join(options.toolsDir || "", "python", "python.exe"),
          path.join(
            options.toolsDir || "",
            "python",
            "python-embed",
            "python.exe",
          ),
          path.join(options.toolsDir || "", "python.exe"),
        ],
  );
  if (bundled) {
    return bundled;
  }
  return shouldAllowSystemPythonFallback(options) ? "python" : null;
}

/** @param {string[]} candidates @returns {string | null} */
function findAvailablePython(candidates) {
  return (
    candidates.find(
      (candidate) =>
        candidate && (candidate === "python" || existsSync(candidate)),
    ) || null
  );
}

/** @param {RuntimeOptions} [options] @returns {boolean} */
function shouldAllowSystemPythonFallback(
  options = /** @type {OcrConfigOptions} */ ({}),
) {
  const explicit =
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_ALLOW_SYSTEM_PYTHON", options) ??
    runtimeOverrideEnv("MANGA_TRANSLATOR_ALLOW_SYSTEM_PYTHON", options);
  return explicit === undefined
    ? !isLikelyPackagedToolsDir(options.toolsDir)
    : isTruthy(explicit);
}

/** @param {string} runtimeDir @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrPythonPackageDir(runtimeDir, options = {}) {
  return shouldUseWindowsShortRocmOcrLayout(options)
    ? path.join(runtimeDir, "p")
    : path.join(
        runtimeDir,
        `python-packages-${resolveOcrRuntimeVariant(options)}`,
      );
}

/** @param {string} runtimeDir @param {string} runtimeVariant @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrVenvDir(runtimeDir, runtimeVariant, options = {}) {
  return shouldUseWindowsShortRocmOcrLayout(options)
    ? path.join(runtimeDir, "v")
    : path.join(runtimeDir, `.venv-${runtimeVariant}`);
}

module.exports = {
  OCR_ROCM_LONGEST_FINAL_ENTRY,
  OCR_ROCM_LONGEST_LIBRARY_ENTRY,
  OCR_ROCM_LONGEST_PIP_TEMP_ENTRY,
  OCR_ROCM_WINDOWS_VERSION,
  WINDOWS_LEGACY_MAX_PATH,
  WINDOWS_PATH_SAFETY_MARGIN,
  hasNonAsciiPath,
  isWindowsRocmOcrRuntimePathShortEnough,
  resolveBootstrapPython,
  resolveInstallProgressDir,
  resolveOcrPipCacheDir,
  resolveOcrPythonPackageDir,
  resolveOcrPythonUserBaseDir,
  resolveOcrRuntimeDir,
  resolveOcrTempDir,
  resolveOcrVenvDir,
  resolvePaddlexCacheAliasRoot,
  resolvePaddlexCacheHome,
  resolveRealPaddlexCacheHome,
  resolveVenvPythonPath,
  shouldAllowSystemPythonFallback,
  shouldUseWindowsShortRocmOcrLayout,
};
