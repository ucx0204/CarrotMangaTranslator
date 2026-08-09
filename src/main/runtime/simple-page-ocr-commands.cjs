// @ts-check
/** @typedef {import("./runtime-jsdoc-types").CommandSpec} CommandSpec */
/** @typedef {import("./runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */
/** @typedef {import("./runtime-jsdoc-types").OcrRuntimeLayout} OcrRuntimeLayout */
const path = require("node:path");

const { normalizeCommandSpec } = require("./transport/shell-text.cjs");
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

const EXTERNAL_COMMAND_ENV = "MANGA_TRANSLATOR_OCR_BBOX_CMD";
const ALLOWED_EXTERNAL_COMMAND_KEYS = new Set(["executable", "args"]);
const ALLOWED_EXTERNAL_PLACEHOLDERS = new Set([
  "{image}",
  "{output}",
  "{sourceLanguage}",
  "{source_language}",
]);
const FORBIDDEN_EXTERNAL_SHELLS = new Set([
  "cmd",
  "cmd.exe",
  "command.com",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "tcsh",
  "wscript",
  "wscript.exe",
  "cscript",
  "cscript.exe",
  "mshta",
  "mshta.exe",
]);

/**
 * @param {RuntimeOptions} [options]
 * @param {string} provider
 * @param {string} outputPath
 * @param {OcrRuntimeLayout | null} [runtime]
 * @returns {CommandSpec}
 */
function buildOcrBboxCommand(
  options = {},
  provider = "",
  outputPath = "",
  runtime = null,
) {
  const template = String(
    options.ocrBboxCommand ??
      runtimeOverrideEnv(EXTERNAL_COMMAND_ENV, options) ??
      "",
  ).trim();
  const imagePath = requireNonEmptyPath(options.imagePath, "OCR image path");
  const normalizedOutputPath = requireNonEmptyPath(
    outputPath,
    "OCR output path",
  );

  if (template) {
    return buildExternalOcrCommand(template, {
      image: imagePath,
      output: normalizedOutputPath,
      sourceLanguage: resolveOcrSourceLanguage(options),
    });
  }

  if (provider === "paddleocr") {
    return {
      executable: resolveOcrRuntimePythonPath(runtime, options),
      args: [
        "-u",
        path.join(__dirname, "paddleocr-bboxes.py"),
        "--image",
        imagePath,
        "--output",
        normalizedOutputPath,
        "--device",
        resolveEffectiveOcrDevice(options),
        ...buildOcrSourceLanguageArgs(options),
        ...buildPaddleOcrBboxModeArgs(options),
      ],
    };
  }

  throw new Error(`OCR bbox provider requires ${EXTERNAL_COMMAND_ENV}.`);
}

/**
 * @param {RuntimeOptions} [options]
 * @param {string} batchPath
 * @param {OcrRuntimeLayout | null} [runtime]
 * @param {string | null} [progressPath]
 * @returns {CommandSpec}
 */
function buildOcrBboxBatchCommand(
  options = {},
  batchPath = "",
  runtime = null,
  progressPath = null,
) {
  const args = [
    "-u",
    path.join(__dirname, "paddleocr-bboxes.py"),
    "--batch",
    requireNonEmptyPath(batchPath, "OCR batch path"),
  ];

  if (progressPath) {
    args.push(
      "--progress",
      requireNonEmptyPath(progressPath, "OCR progress path"),
    );
  }

  args.push(
    "--device",
    resolveEffectiveOcrDevice(options),
    ...buildOcrSourceLanguageArgs(options),
    ...buildPaddleOcrBboxModeArgs(options),
  );

  return {
    executable: resolveOcrRuntimePythonPath(runtime, options),
    args,
  };
}

/**
 * @param {string} template
 * @param {{ image: string; output: string; sourceLanguage: string }} replacements
 * @returns {CommandSpec}
 */
function buildExternalOcrCommand(template, replacements) {
  const parsed = parseExternalCommandJson(template);
  const normalized = normalizeCommandSpec(parsed);
  assertAllowedExternalExecutable(normalized.executable);
  assertNoExecutablePlaceholder(normalized.executable);
  return {
    executable: normalized.executable,
    args: normalized.args.map((arg) =>
      replaceExternalCommandPlaceholder(arg, replacements),
    ),
  };
}

/** @param {string} template @returns {unknown} */
function parseExternalCommandJson(template) {
  try {
    const parsed = JSON.parse(template);
    assertPlainCommandObject(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }
    throw createLegacyExternalCommandError(error);
  }
}

/** @param {unknown} value */
function assertPlainCommandObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("External OCR command spec must be a JSON object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("External OCR command spec must be a plain object.");
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_EXTERNAL_COMMAND_KEYS.has(key)) {
      throw new TypeError(`External OCR command spec has unknown key: ${key}.`);
    }
  }
}

/** @param {unknown} cause */
function createLegacyExternalCommandError(cause) {
  const error = new Error(
    `${EXTERNAL_COMMAND_ENV} no longer accepts a shell command string. ` +
      'Use a JSON object { "executable": string, "args": string[] }, and place each placeholder in its own argv element.',
  );
  error.cause = cause;
  return error;
}

/** @param {string} executable */
function assertAllowedExternalExecutable(executable) {
  const basename = crossPlatformBasename(executable).toLowerCase();
  if (FORBIDDEN_EXTERNAL_SHELLS.has(basename)) {
    throw new TypeError(
      `External OCR command executable must not be a shell: ${basename}.`,
    );
  }
}

/** @param {string} executable */
function assertNoExecutablePlaceholder(executable) {
  if (containsPlaceholderSyntax(executable)) {
    throw new TypeError(
      "External OCR command executable must not contain placeholders.",
    );
  }
}

/**
 * @param {string} arg
 * @param {{ image: string; output: string; sourceLanguage: string }} replacements
 */
function replaceExternalCommandPlaceholder(arg, replacements) {
  if (arg === "{image}") return replacements.image;
  if (arg === "{output}") return replacements.output;
  if (arg === "{sourceLanguage}" || arg === "{source_language}") {
    return replacements.sourceLanguage;
  }

  const placeholders = arg.match(/\{[^{}]*\}/g) || [];
  if (placeholders.length > 0) {
    const unknown = placeholders.find(
      (placeholder) => !ALLOWED_EXTERNAL_PLACEHOLDERS.has(placeholder),
    );
    if (unknown) {
      throw new TypeError(
        `Unknown external OCR command placeholder: ${unknown}.`,
      );
    }
    throw new TypeError(
      `External OCR command placeholder must be a separate argv element: ${arg}.`,
    );
  }
  if (containsPlaceholderSyntax(arg)) {
    throw new TypeError(
      `Invalid external OCR command placeholder syntax: ${arg}.`,
    );
  }
  return arg;
}

/** @param {string} value */
function containsPlaceholderSyntax(value) {
  return value.includes("{") || value.includes("}");
}

/** @param {unknown} value */
function crossPlatformBasename(value) {
  return String(value).replace(/\\/g, "/").split("/").at(-1) || "";
}

/**
 * OCR source language argv. PaddleOCR-specific language mapping remains in the
 * Python adapter; this layer only forwards the language code.
 * @param {RuntimeOptions} [options]
 * @returns {string[]}
 */
function buildOcrSourceLanguageArgs(options = {}) {
  const sourceLanguage = resolveOcrSourceLanguage(options);
  return !sourceLanguage || isJapaneseLanguageCode(sourceLanguage)
    ? []
    : ["--source-language", sourceLanguage];
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
 * @returns {string[]}
 */
function buildPaddleOcrBboxModeArgs(options = {}) {
  const device = resolveOcrDevice(options);
  const rocmTransformers =
    device.startsWith("gpu") &&
    resolveOcrGpuBackend(options) === "rocm-transformers";
  const rocmDefaults = rocmTransformers
    ? {
        engine: "transformers",
        dtype: "float32",
        ocrVersion: "PP-OCRv6",
      }
    : {};
  return renderPaddleOcrModeArgs([
    ["--bbox-mode", "ocr"],
    resolvePaddleOcrModeArg(
      "--engine",
      "MANGA_TRANSLATOR_PADDLEOCR_ENGINE",
      options.ocrEngine,
      rocmDefaults.engine,
      options,
    ),
    resolvePaddleOcrModeArg(
      "--dtype",
      "MANGA_TRANSLATOR_PADDLEOCR_ENGINE_DTYPE",
      options.ocrEngineDtype,
      rocmDefaults.dtype,
      options,
    ),
    resolvePaddleOcrModeArg(
      "--ocr-version",
      "MANGA_TRANSLATOR_PADDLEOCR_VERSION",
      options.ocrVersion,
      rocmDefaults.ocrVersion,
      options,
    ),
    resolvePaddleOcrModeArg(
      "--text-detection-model-name",
      "MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME",
      options.ocrTextDetectionModelName,
      "",
      options,
    ),
    resolvePaddleOcrModeArg(
      "--text-recognition-model-name",
      "MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME",
      options.ocrTextRecognitionModelName,
      "",
      options,
    ),
    ["--merge-mode", "semantic"],
  ]);
}

/**
 * @param {string} flag
 * @param {string} envKey
 * @param {unknown} optionValue
 * @param {unknown} fallback
 * @param {RuntimeOptions} options
 * @returns {[string, string]}
 */
function resolvePaddleOcrModeArg(flag, envKey, optionValue, fallback, options) {
  const value =
    runtimeOverrideEnv(envKey, options) ||
    readOptionString(optionValue) ||
    readOptionString(fallback);
  return [flag, value];
}

/**
 * @param {Array<[string, string]>} entries
 * @returns {string[]}
 */
function renderPaddleOcrModeArgs(entries) {
  return entries.flatMap(([flag, value]) => (value ? [flag, value] : []));
}

/** @param {unknown} value @param {string} label */
function requireNonEmptyPath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${label} must not contain NUL bytes.`);
  }
  return value;
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
  throw new Error("Paddle OCR bbox provider needs an isolated Python runtime.");
}

module.exports = {
  buildOcrSourceLanguageArgs,
  buildPaddleOcrBboxModeArgs,
  buildOcrBboxBatchCommand,
  buildOcrBboxCommand,
  resolveOcrSourceLanguage,
  resolveOcrRuntimePythonPath,
};
