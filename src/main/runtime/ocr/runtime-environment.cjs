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
  buildIsolatedPipEnvironment,
} = require("../python-pip-environment.cjs");
const {
  HF_CHILD_ENV_KEYS,
  NETWORK_CHILD_ENV_KEYS,
  ROCM_CHILD_ENV_KEYS,
  buildWhitelistedChildEnv,
  runtimeOverrideEnv,
  shouldAllowExternalRuntimeOverrides,
} = require("./host-services.cjs");
const {
  readOptionString,
  readPositiveIntegerOption,
} = require("./config-values.cjs");
const {
  isHayaiOcrPipeline,
  isPaddleTransformersEngine,
  resolveEffectiveOcrDevice,
  resolveOcrDevice,
  resolveOcrGpuBackend,
  resolveOcrGpuCudaTag,
} = require("./runtime-device.cjs");
const {
  resolveOcrPipCacheDir,
  resolveOcrPythonPackageDir,
  resolveOcrPythonUserBaseDir,
  resolveOcrRuntimeDir,
  resolveOcrTempDir,
  resolvePaddlexCacheHome,
  shouldUseWindowsShortRocmOcrLayout,
} = require("./runtime-layout.cjs");
const {
  buildOcrRuntimeDllSearchDirs,
  buildOcrRuntimePathDirs,
  resolveOcrVenvBinDir,
} = require("./runtime-path-environment.cjs");

const EXTERNAL_ROCM_PATH_ENV_KEYS = new Set([
  "ROCM_PATH",
  "HIP_PATH",
  "LD_LIBRARY_PATH",
  "LIBRARY_PATH",
]);

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
    ...buildEngineModeEnv(options, context.ocrDevice, context.ocrGpuBackend),
    ...buildOcrCpuThreadEnv(options, context.ocrDevice),
    ...buildRocmSafetyEnv(options, context.rocmGpuRequested),
    ...buildPythonRuntimeEnv(options, runtime, context),
  };
  gpuSelection.applyOcrComputeGpuVisibility(env, options, context);
  return buildIsolatedPipEnvironment(env, {
    PIP_CACHE_DIR: env.PIP_CACHE_DIR,
  });
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
  const env = {
    MANGA_TRANSLATOR_OCR_DEVICE: resolveEffectiveOcrDevice(options),
    MANGA_TRANSLATOR_OCR_GPU_BACKEND: context.ocrGpuBackend,
    MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE:
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE", options) ||
      String(options.sourceLanguage || "ja"),
    MANGA_TRANSLATOR_OCR_GPU_CUDA_TAG: resolveOcrGpuCudaTag(options),
    MANGA_TRANSLATOR_OCR_DLL_DIRS: context.dllSearchDirs.join(path.delimiter),
  };
  return isHayaiOcrPipeline(options)
    ? env
    : {
        ...env,
        MANGA_TRANSLATOR_PADDLEOCR_DEVICE: resolveEffectiveOcrDevice(options),
      };
}

/** @param {RuntimeOptions} options @param {boolean} enabled @returns {Record<string, string>} */
function buildRocmSafetyEnv(options, enabled) {
  if (!enabled) {
    return {};
  }
  const legacyDisableMiopen = isHayaiOcrPipeline(options)
    ? undefined
    : runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN", options);
  const torchEnv = {
    PYTORCH_ALLOC_CONF:
      process.env.PYTORCH_ALLOC_CONF ||
      process.env.PYTORCH_HIP_ALLOC_CONF ||
      runtimeOverrideEnv("PYTORCH_ALLOC_CONF", options) ||
      runtimeOverrideEnv("PYTORCH_HIP_ALLOC_CONF", options) ||
      "garbage_collection_threshold:0.8,max_split_size_mb:512",
    MANGA_TRANSLATOR_OCR_DISABLE_MIOPEN:
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_DISABLE_MIOPEN", options) ||
      legacyDisableMiopen ||
      "1",
  };
  return isHayaiOcrPipeline(options)
    ? torchEnv
    : {
        ...torchEnv,
        MANGA_TRANSLATOR_PADDLEOCR_ATTN:
          runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_ATTN", options) ||
          "eager",
        MANGA_TRANSLATOR_PADDLEOCR_DISABLE_MIOPEN: legacyDisableMiopen || "1",
      };
}

/** @param {RuntimeOptions} options @param {OcrRuntimeLayout | null} runtime @param {OcrEnvContext} context @returns {Record<string, string>} */
function buildPythonRuntimeEnv(options, runtime, context) {
  const tempDir = resolveOcrTempDir(context.runtimeDir, options);
  const baseEnv = {
    PYTHONPATH: context.pythonPath,
    PYTHONNOUSERSITE: "1",
    // The bundled macOS interpreter lives inside the signed .app.  Importing
    // from it must never create __pycache__ entries there, otherwise the first
    // OCR run invalidates the app's code-signature seal.
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPYCACHEPREFIX: path.join(context.runtimeDir, "pycache"),
    PYTHONUSERBASE: resolveOcrPythonUserBaseDir(context.runtimeDir, options),
    PIP_CACHE_DIR: resolveOcrPipCacheDir(context.runtimeDir, options),
    TMP: tempDir,
    TEMP: tempDir,
    TMPDIR: tempDir,
    PYTHONUTF8: "1",
    PYTHONUNBUFFERED: "1",
  };
  if (isHayaiOcrPipeline(options)) {
    return baseEnv;
  }
  return {
    ...baseEnv,
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
  };
}

/** @param {RuntimeOptions} [options] @param {string} [ocrDevice] @returns {Record<string, string>} */
function buildOcrCpuThreadEnv(options = {}, ocrDevice = "") {
  if (ocrDevice !== "cpu") {
    return {};
  }
  const threads = String(resolveOcrWorkerThreadCount(options));
  const shared = {
    MKL_NUM_THREADS: threads,
    NUMEXPR_NUM_THREADS: threads,
    OMP_NUM_THREADS: threads,
    OPENBLAS_NUM_THREADS: threads,
    VECLIB_MAXIMUM_THREADS: threads,
  };
  return isHayaiOcrPipeline(options)
    ? shared
    : {
        ...shared,
        FLAGS_cpu_math_library_num_threads: threads,
        PADDLE_NUM_THREADS: threads,
      };
}

/** @param {RuntimeOptions} options @param {string} ocrDevice @param {string} ocrGpuBackend */
function buildEngineModeEnv(options, ocrDevice, ocrGpuBackend) {
  return isHayaiOcrPipeline(options)
    ? {}
    : buildPaddleOcrModeEnv(options, ocrDevice, ocrGpuBackend);
}

/** @param {RuntimeOptions} [options] @returns {number} */
function resolveOcrWorkerThreadCount(options = {}) {
  return (
    readPositiveIntegerOption(
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_WORKER_THREADS", options),
    ) ||
    (!isHayaiOcrPipeline(options)
      ? readPositiveIntegerOption(
          runtimeOverrideEnv(
            "MANGA_TRANSLATOR_PADDLEOCR_WORKER_THREADS",
            options,
          ),
        )
      : null) ||
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
    isPaddleTransformersEngine({ ...options, ocrGpuBackend });
  const defaults = transformersRuntime
    ? {
        engine: "transformers",
        dtype: "float32",
        version: "PP-OCRv6",
        detLimit: "1600",
        recBatch: "1",
      }
    : {
        engine: "",
        dtype: "",
        version: "",
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
    ["MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE", "ocr"],
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
    ["MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE", "semantic"],
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

module.exports = {
  buildOcrRuntimeEnv,
  buildOcrCpuThreadEnv,
  resolveOcrVenvBinDir,
  resolveOcrWorkerThreadCount,
};
