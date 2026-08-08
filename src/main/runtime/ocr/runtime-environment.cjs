// @ts-check
/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("../runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
/**
 * @typedef {RuntimeOptions & {
 *   hfHomeDir?: string | null;
 *   hfHubCacheDir?: string | null;
 *   [key: string]: unknown;
 * }} OcrConfigOptions
 */
/**
 * @typedef {{
 *   runtimeDir: string;
 *   packageDir: string;
 *   pythonPath: string;
 *   hfHomeDir: string;
 *   hfHubCacheDir: string;
 *   dllSearchDirs: string[];
 *   ocrDevice: string;
 *   ocrGpuBackend: string;
 *   rocmGpuRequested: boolean;
 * }} OcrEnvContext
 */

const path = require("node:path");
const gpuSelection = require("../compute-gpu-selection.cjs");
const {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  ROCM_CHILD_ENV_KEYS,
  buildWhitelistedChildEnv,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides,
} = require("./host-services.cjs");
const { resolveToolsDir } = require("../simple-page-runtime-paths.cjs");
const {
  readOptionString,
  readPositiveIntegerOption,
} = require("./config-values.cjs");
const {
  isOcrCudaTransformersRuntime,
  isOcrTransformersEngine,
  resolveEffectiveOcrDevice,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
  resolveOcrRuntimeVariant,
} = require("./runtime-device.cjs");
const {
  resolveOcrPipCacheDir,
  resolveOcrPythonPackageDir,
  resolveOcrPythonUserBaseDir,
  resolveOcrRuntimeDir,
  resolveOcrTempDir,
  resolveOcrVenvDir,
  resolvePaddlexCacheHome,
  shouldUseWindowsShortRocmOcrLayout,
} = require("./runtime-layout.cjs");

const EXTERNAL_ROCM_PATH_ENV_KEYS = new Set([
  "ROCM_PATH",
  "HIP_PATH",
  "LD_LIBRARY_PATH",
  "LIBRARY_PATH",
]);
const TORCH_DLL_RELATIVE_DIRS = ["Scripts", "torch", path.join("torch", "lib")];

/** @param {RuntimeOptions} [options] @param {OcrRuntimeLayout | null} [runtime] @returns {NodeJS.ProcessEnv} */
function buildOcrRuntimeEnv(
  options = /** @type {OcrConfigOptions} */ ({}),
  runtime = null,
) {
  const context = createOcrEnvContext(options, runtime);
  const env = {
    ...buildBaseChildEnv(options, runtime, context),
    ...buildHuggingFaceEnv(options, context),
    ...buildOcrDeviceEnv(options, context),
    ...buildPaddleOcrModeEnv(options, context.ocrDevice, context.ocrGpuBackend),
    ...buildPaddleOcrCpuThreadEnv(options, context.ocrDevice),
    ...buildRocmSafetyEnv(options, context.rocmGpuRequested),
    ...buildPythonRuntimeEnv(options, runtime, context),
  };
  gpuSelection.applyOcrComputeGpuVisibility(env, options, context);
  return env;
}

/** @param {OcrConfigOptions} options @param {OcrRuntimeLayout | null} runtime @returns {OcrEnvContext} */
function createOcrEnvContext(options, runtime) {
  const runtimeDir = runtime?.runtimeDir || resolveOcrRuntimeDir(options);
  const { hfHomeDir, hfHubCacheDir } = resolveHuggingFaceCacheDirs(
    options,
    runtimeDir,
  );
  const packageDir =
    runtime?.packageDir || resolveOcrPythonPackageDir(runtimeDir, options);
  const includePackageDir =
    runtime?.includePackageDir ?? runtime?.usesTargetPackageDir ?? true;
  const ocrDevice = resolveOcrDevice(options);
  const ocrGpuBackend = resolveOcrGpuBackend(options);
  return {
    runtimeDir,
    packageDir,
    pythonPath: includePackageDir ? packageDir : "",
    hfHomeDir,
    hfHubCacheDir,
    dllSearchDirs: buildOcrRuntimeDllSearchDirs(options, runtime, runtimeDir),
    ocrDevice,
    ocrGpuBackend,
    rocmGpuRequested:
      ocrGpuBackend === "rocm-transformers" && ocrDevice.startsWith("gpu"),
  };
}

/** @param {OcrConfigOptions} options @param {string} runtimeDir @returns {{ hfHomeDir: string; hfHubCacheDir: string }} */
function resolveHuggingFaceCacheDirs(options, runtimeDir) {
  const hfHomeDir = String(
    options.hfHomeDir ||
      runtimeOverrideEnv("HF_HOME", options) ||
      (shouldUseWindowsShortRocmOcrLayout(options)
        ? path.join(runtimeDir, "h")
        : path.join(runtimeDir, "hf-cache")),
  );
  const hfHubCacheDir = String(
    options.hfHubCacheDir ||
      runtimeOverrideEnv("HF_HUB_CACHE", options) ||
      runtimeOverrideEnv("HUGGINGFACE_HUB_CACHE", options) ||
      path.join(hfHomeDir, "hub"),
  );
  return { hfHomeDir, hfHubCacheDir };
}

/** @param {RuntimeOptions} options @param {OcrRuntimeLayout | null} runtime @param {OcrEnvContext} context @returns {NodeJS.ProcessEnv} */
function buildBaseChildEnv(options, runtime, context) {
  const allowExternalRuntime = shouldAllowExternalRuntimeOverrides(options);
  const rocmChildEnvKeys = ROCM_CHILD_ENV_KEYS.filter(
    (key) =>
      key !== "PYTORCH_ALLOC_CONF" &&
      key !== "PYTORCH_HIP_ALLOC_CONF" &&
      (allowExternalRuntime || !EXTERNAL_ROCM_PATH_ENV_KEYS.has(key)),
  );
  const extraKeys = [
    ...NETWORK_CHILD_ENV_KEYS,
    ...HF_CHILD_ENV_KEYS,
    ...(context.rocmGpuRequested ? rocmChildEnvKeys : []),
  ];
  return buildWhitelistedChildEnv({
    pathDirs: buildOcrRuntimePathDirs(options, runtime, context.runtimeDir),
    includeProcessPath: allowExternalRuntime,
    extraKeys,
  });
}

/** @param {RuntimeOptions} options @param {OcrEnvContext} context @returns {Record<string, string>} */
function buildHuggingFaceEnv(options, context) {
  return {
    HF_HOME: context.hfHomeDir,
    HF_HUB_CACHE: context.hfHubCacheDir,
    HUGGINGFACE_HUB_CACHE: context.hfHubCacheDir,
    HF_HUB_DISABLE_XET:
      runtimeOverrideEnv("HF_HUB_DISABLE_XET", options) || "1",
    HF_HUB_ETAG_TIMEOUT:
      runtimeOverrideEnv("HF_HUB_ETAG_TIMEOUT", options) || "30",
    HF_HUB_DOWNLOAD_TIMEOUT:
      runtimeOverrideEnv("HF_HUB_DOWNLOAD_TIMEOUT", options) || "300",
  };
}

/** @param {RuntimeOptions} options @param {OcrEnvContext} context @returns {Record<string, string>} */
function buildOcrDeviceEnv(options, context) {
  return {
    MANGA_TRANSLATOR_OCR_DEVICE: String(
      options.ocrDevice ||
        runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DEVICE", options) ||
        "cpu",
    ),
    MANGA_TRANSLATOR_OCR_GPU_BACKEND: context.ocrGpuBackend,
    MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE:
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE", options) ||
      String(options.sourceLanguage || "ja"),
    MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG: resolveOcrGpuCudaTag(options),
    MANGA_TRANSLATOR_OCR_DLL_DIRS: context.dllSearchDirs.join(path.delimiter),
    MANGA_TRANSLATOR_PADDLEOCR_DEVICE: resolveEffectiveOcrDevice(options),
  };
}

/** @param {RuntimeOptions} options @param {boolean} enabled @returns {Record<string, string>} */
function buildRocmSafetyEnv(options, enabled) {
  if (!enabled) {
    return {};
  }
  return {
    MANGA_TRANSLATOR_PADDLEOCR_ATTN:
      runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_ATTN", options) || "eager",
    MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN:
      runtimeOverrideEnv(
        "MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN",
        options,
      ) || "1",
    PYTORCH_ALLOC_CONF:
      process.env.PYTORCH_ALLOC_CONF ||
      process.env.PYTORCH_HIP_ALLOC_CONF ||
      runtimeOverrideEnv("PYTORCH_ALLOC_CONF", options) ||
      runtimeOverrideEnv("PYTORCH_HIP_ALLOC_CONF", options) ||
      "garbage_collection_threshold:0.8,max_split_size_mb:512",
  };
}

/** @param {RuntimeOptions} options @param {OcrRuntimeLayout | null} runtime @param {OcrEnvContext} context @returns {Record<string, string>} */
function buildPythonRuntimeEnv(options, runtime, context) {
  const tempDir = resolveOcrTempDir(context.runtimeDir, options);
  return {
    PYTHONPATH: context.pythonPath,
    PYTHONNOUSERSITE: "1",
    // The bundled macOS interpreter lives inside the signed .app.  Importing
    // from it must never create __pycache__ entries there, otherwise the first
    // OCR run invalidates the app's code-signature seal.
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: path.join(context.runtimeDir, "pycache"),
    PYTHONUSERBASE: resolveOcrPythonUserBaseDir(context.runtimeDir, options),
    PIP_CACHE_DIR: resolveOcrPipCacheDir(context.runtimeDir, options),
    PADDLE_PDX_MODEL_SOURCE:
      runtimeOverrideEnv("PADDLE_PDX_MODEL_SOURCE", options) || "huggingface",
    PADDLE_PDX_CACHE_HOME: resolvePaddlexCacheHome(
      context.runtimeDir,
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
    TMPDIR: tempDir,
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
  };
}

/** @param {RuntimeOptions} [options] @param {string} [ocrDevice] @returns {Record<string, string>} */
function buildPaddleOcrCpuThreadEnv(options = {}, ocrDevice = "") {
  if (ocrDevice !== "cpu") {
    return {};
  }
  const threads = String(resolvePaddleOcrWorkerThreadCount(options));
  return {
    FLAGS_cpu_math_library_num_threads: threads,
    MKL_NUM_THREADS: threads,
    NUMEXPR_NUM_THREADS: threads,
    OMP_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    PADDLE_NUM_THREADS: threads,
    VECLIB_MAXIMUM_THREADS: threads,
  };
}

/** @param {RuntimeOptions} [options] @returns {number} */
function resolvePaddleOcrWorkerThreadCount(options = {}) {
  return (
    readPositiveIntegerOption(
      runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_WORKER_THREADS", options),
    ) ||
    readPositiveIntegerOption(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_WORKER_THREADS", options),
    ) ||
    readPositiveIntegerOption(options.ocrWorkerThreads) ||
    2
  );
}

/** @param {RuntimeOptions} [options] @param {string} [ocrDevice] @param {string} [ocrGpuBackend] @returns {Record<string, string>} */
function buildPaddleOcrModeEnv(
  options = {},
  ocrDevice = "",
  ocrGpuBackend = "",
) {
  const transformersRuntime =
    String(ocrDevice).startsWith("gpu") &&
    isOcrTransformersEngine({ ...options, ocrGpuBackend });
  const defaults = transformersRuntime
    ? {
        engine: "transformers",
        dtype: "float32",
        bboxMode: "ocr",
        version: "PP-OCRv6",
        mergeMode: "semantic",
        detLimit: "1600",
        recBatch: "1",
      }
    : {
        engine: "",
        dtype: "",
        bboxMode: "",
        version: "",
        mergeMode: "",
        detLimit: "",
        recBatch: "",
      };
  const entries = resolvePaddleOcrModeEntries(options, defaults);
  return Object.fromEntries(entries.filter((entry) => Boolean(entry[1])));
}

/** @param {RuntimeOptions} options @param {Record<string, string>} defaults @returns {Array<[string, string]>} */
function resolvePaddleOcrModeEntries(options, defaults) {
  return [
    modeEntry(
      "MANGA_TRANSLATOR_PADDLEOCR_ENGINE",
      options.ocrEngine,
      defaults.engine,
      options,
    ),
    modeEntry(
      "MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE",
      options.ocrEngineDtype,
      defaults.dtype,
      options,
    ),
    modeEntry(
      "MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE",
      options.ocrBboxMode,
      defaults.bboxMode,
      options,
    ),
    modeEntry(
      "MANGA_TRANSLATOR_PADDLEOCR_VERSION",
      options.ocrVersion,
      defaults.version,
      options,
    ),
    modeEntry(
      "MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME",
      options.ocrTextDetectionModelName,
      "",
      options,
    ),
    modeEntry(
      "MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME",
      options.ocrTextRecognitionModelName,
      "",
      options,
    ),
    modeEntry(
      "MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE",
      options.ocrMergeMode,
      defaults.mergeMode,
      options,
    ),
    modeEntry(
      "MANGA_TRANSLATOR_PADDLEOCR_DET_LIMIT",
      options.ocrDetLimit,
      defaults.detLimit,
      options,
    ),
    modeEntry(
      "MANGA_TRANSLATOR_PADDLEOCR_REC_BATCH",
      options.ocrRecBatch,
      defaults.recBatch,
      options,
    ),
  ];
}

/** @param {string} key @param {unknown} optionValue @param {unknown} fallback @param {RuntimeOptions} options @returns {[string, string]} */
function modeEntry(key, optionValue, fallback, options) {
  const value =
    runtimeOverrideEnv(key, options) ||
    readOptionString(optionValue) ||
    readOptionString(fallback);
  return [key, value];
}

/** @param {RuntimeOptions} [options] @param {OcrRuntimeLayout | null} [runtime] @param {string} [runtimeDir] @returns {Array<string | null | undefined>} */
function buildOcrRuntimePathDirs(
  options = {},
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
  return [
    runtime?.pythonPath ? path.dirname(runtime.pythonPath) : null,
    venvBinDir,
    ...buildOcrRuntimeDllSearchDirs(options, runtime, runtimeDir),
    path.join(toolsDir || "", "python"),
    path.join(toolsDir || "", "python", "python-embed"),
    runtimeDir,
  ];
}

/** @param {RuntimeOptions} [options] @param {OcrRuntimeLayout | null} [runtime] @param {string} [runtimeDir] @returns {string[]} */
function buildOcrRuntimeDllSearchDirs(
  options = {},
  runtime = null,
  runtimeDir = resolveOcrRuntimeDir(options),
) {
  const packageDir =
    runtime?.packageDir || resolveOcrPythonPackageDir(runtimeDir, options);
  const paddleDirs = buildPaddleDllSearchDirs(packageDir);
  if (resolveOcrGpuBackend(options) === "rocm-transformers") {
    return [...paddleDirs, ...buildRocmDllSearchDirs(packageDir)];
  }
  return isOcrCudaTransformersRuntime(options)
    ? [...paddleDirs, ...buildTorchDllSearchDirs(packageDir)]
    : paddleDirs;
}

/** @param {string} packageDir @returns {string[]} */
function buildPaddleDllSearchDirs(packageDir) {
  return [
    packageDir,
    path.join(packageDir, "paddle"),
    path.join(packageDir, "paddle", "base"),
    path.join(packageDir, "paddle", "base", "libs"),
    path.join(packageDir, "paddle", "libs"),
    path.join(packageDir, "paddle.libs"),
    path.join(packageDir, "Paddle.libs"),
  ];
}

/** @param {string} packageDir @returns {string[]} */
function buildRocmDllSearchDirs(packageDir) {
  return [
    ...TORCH_DLL_RELATIVE_DIRS,
    "rocm",
    path.join("rocm", "bin"),
    path.join("rocm", "lib"),
    "rocm_sdk",
    path.join("rocm_sdk", "bin"),
    "_rocm_sdk_core",
    path.join("_rocm_sdk_core", "bin"),
    path.join("_rocm_sdk_core", "lib", "llvm", "bin"),
    "_rocm_sdk_devel",
    path.join("_rocm_sdk_devel", "bin"),
    path.join("_rocm_sdk_devel", "lib", "llvm", "bin"),
    "_rocm_sdk_libraries_custom",
    path.join("_rocm_sdk_libraries_custom", "bin"),
    path.join("_rocm_sdk_libraries_custom", "bin", "hipblaslt"),
    path.join("_rocm_sdk_libraries_custom", "bin", "hipblaslt", "library"),
  ].map((relativePath) => path.join(packageDir, relativePath));
}

/** @param {string} packageDir @returns {string[]} */
function buildTorchDllSearchDirs(packageDir) {
  return TORCH_DLL_RELATIVE_DIRS.map((relativePath) =>
    path.join(packageDir, relativePath),
  );
}

module.exports = {
  buildOcrRuntimeEnv,
  buildPaddleOcrCpuThreadEnv,
  resolvePaddleOcrWorkerThreadCount,
};
