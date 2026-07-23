// @ts-check
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
const path = require("node:path");

const {
  quoteCommandArg,
  renderCommandTemplate,
} = require("./simple-page-shell-utils.cjs");
const {
  resolveBootstrapPython,
  resolveEffectiveOcrDevice,
  resolveOcrDevice,
  resolveOcrGpuBackend,
} = require("./simple-page-ocr-runtime-config.cjs");
const { runtimeOverrideEnv } = require("./simple-page-child-env.cjs");
const {
  isJapaneseLanguageCode,
} = require("./simple-page-language-profile.cjs");

/**
 * @param {RuntimeOptions} [options]
 * @param {string} provider
 * @param {string} outputPath
 * @param {OcrRuntimeLayout | null} [runtime]
 * @returns {string}
 */
function buildOcrBboxCommand(
  options = {},
  provider = "",
  outputPath = "",
  runtime = null,
) {
  const template = String(
    options.ocrBboxCommand ??
      runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_BBOX_CMD", options) ??
      "",
  ).trim();
  const image = options.imagePath;
  const replacements = {
    image: quoteCommandArg(image),
    output: quoteCommandArg(outputPath),
    sourceLanguage: quoteCommandArg(resolveOcrSourceLanguage(options)),
    source_language: quoteCommandArg(resolveOcrSourceLanguage(options)),
  };

  if (template) {
    return renderCommandTemplate(template, replacements);
  }

  if (provider === "paddleocr-vl") {
    const python = quoteCommandArg(
      resolveOcrRuntimePythonPath(runtime, options),
    );
    const scriptPath = quoteCommandArg(
      path.join(__dirname, "paddleocr-vl-bboxes.py"),
    );
    return `${python} -u ${scriptPath} --image ${quoteCommandArg(image)} --output ${quoteCommandArg(outputPath)} --device ${quoteCommandArg(resolveEffectiveOcrDevice(options))}${buildOcrSourceLanguageArg(options)}${buildPaddleOcrBboxModeArgs(options)}`;
  }

  throw new Error("OCR bbox provider requires MANGA_TRANSLATOR_OCR_BBOX_CMD.");
}

/**
 * @param {RuntimeOptions} [options]
 * @param {string} batchPath
 * @param {OcrRuntimeLayout | null} [runtime]
 * @param {string | null} [progressPath]
 * @returns {string}
 */
function buildOcrBboxBatchCommand(
  options = {},
  batchPath = "",
  runtime = null,
  progressPath = null,
) {
  const python = quoteCommandArg(resolveOcrRuntimePythonPath(runtime, options));
  const scriptPath = quoteCommandArg(
    path.join(__dirname, "paddleocr-vl-bboxes.py"),
  );
  const progressArg = progressPath
    ? ` --progress ${quoteCommandArg(progressPath)}`
    : "";
  return `${python} -u ${scriptPath} --batch ${quoteCommandArg(batchPath)}${progressArg} --device ${quoteCommandArg(resolveEffectiveOcrDevice(options))}${buildOcrSourceLanguageArg(options)}${buildPaddleOcrBboxModeArgs(options)}`;
}

/**
 * OCR 원문 언어 인자. PaddleOCR 전용 lang 문자열 매핑은 Python 어댑터
 * (paddleocr-vl-bboxes.py) 내부에만 있고, 여기서는 언어 코드만 넘긴다.
 * 기본값(ja)은 기존 명령과 동일하게 인자를 생략한다.
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function buildOcrSourceLanguageArg(options = {}) {
  const sourceLanguage = resolveOcrSourceLanguage(options);
  if (!sourceLanguage || isJapaneseLanguageCode(sourceLanguage)) {
    return "";
  }
  return ` --source-language ${quoteCommandArg(sourceLanguage)}`;
}

/** @param {RuntimeOptions} [options] @returns {string} */
function resolveOcrSourceLanguage(options = {}) {
  return (
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE", options) ||
    readOptionString(options.sourceLanguage) ||
    "ja"
  );
}

/**
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function buildPaddleOcrBboxModeArgs(options = {}) {
  const device = resolveOcrDevice(options);
  const rocmTransformers =
    device.startsWith("gpu") &&
    resolveOcrGpuBackend(options) === "rocm-transformers";
  const rocmDefaults = rocmTransformers
    ? {
        bboxMode: "ocr",
        engine: "transformers",
        dtype: "float32",
        ocrVersion: "PP-OCRv6",
        mergeMode: "semantic",
      }
    : {};
  return renderPaddleOcrModeArgs([
    resolvePaddleOcrModeArg(
      " --bbox-mode ",
      "MANGA_TRANSLATOR_PADDLEOCR_BBOX_MODE",
      options.ocrBboxMode,
      rocmDefaults.bboxMode,
      options,
    ),
    resolvePaddleOcrModeArg(
      " --engine ",
      "MANGA_TRANSLATOR_PADDLEOCR_ENGINE",
      options.ocrEngine,
      rocmDefaults.engine,
      options,
    ),
    resolvePaddleOcrModeArg(
      " --dtype ",
      "MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE",
      options.ocrEngineDtype,
      rocmDefaults.dtype,
      options,
    ),
    resolvePaddleOcrModeArg(
      " --ocr-version ",
      "MANGA_TRANSLATOR_PADDLEOCR_VERSION",
      options.ocrVersion,
      rocmDefaults.ocrVersion,
      options,
    ),
    resolvePaddleOcrModeArg(
      " --text-detection-model-name ",
      "MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME",
      options.ocrTextDetectionModelName,
      "",
      options,
    ),
    resolvePaddleOcrModeArg(
      " --text-recognition-model-name ",
      "MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME",
      options.ocrTextRecognitionModelName,
      "",
      options,
    ),
    resolvePaddleOcrModeArg(
      " --merge-mode ",
      "MANGA_TRANSLATOR_PADDLEOCR_MERGE_MODE",
      options.ocrMergeMode,
      rocmDefaults.mergeMode,
      options,
    ),
  ]);
}

/**
 * @param {string} prefix
 * @param {string} envKey
 * @param {unknown} optionValue
 * @param {unknown} fallback
 * @param {RuntimeOptions} options
 * @returns {[string, string]}
 */
function resolvePaddleOcrModeArg(
  prefix,
  envKey,
  optionValue,
  fallback,
  options,
) {
  const value =
    runtimeOverrideEnv(envKey, options) ||
    readOptionString(optionValue) ||
    readOptionString(fallback);
  return [prefix, value];
}

/**
 * @param {Array<[string, string]>} entries
 * @returns {string}
 */
function renderPaddleOcrModeArgs(entries) {
  return entries
    .filter((entry) => Boolean(entry[1]))
    .map(([prefix, value]) => `${prefix}${quoteCommandArg(value)}`)
    .join("");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function readOptionString(value) {
  return String(value ?? "").trim();
}

/**
 * @param {OcrRuntimeLayout | null} [runtime]
 * @param {RuntimeOptions} [options]
 * @returns {string}
 */
function resolveOcrRuntimePythonPath(runtime = null, options = {}) {
  if (runtime?.pythonPath) {
    return runtime.pythonPath;
  }
  const pythonPath = resolveBootstrapPython(options);
  if (pythonPath) {
    return pythonPath;
  }
  throw new Error(
    "PaddleOCR-VL bbox provider needs an isolated Python runtime.",
  );
}

module.exports = {
  buildOcrSourceLanguageArg,
  buildPaddleOcrBboxModeArgs,
  buildOcrBboxBatchCommand,
  buildOcrBboxCommand,
  resolveOcrSourceLanguage,
  resolveOcrRuntimePythonPath,
};
