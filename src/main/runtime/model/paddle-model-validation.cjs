// @ts-check
const {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
} = require("node:fs");
const path = require("node:path");
const { PADDLE_OCR_MODEL_DOWNLOADS } = require("../simple-page-defaults.cjs");
const { getFileSize } = require("../simple-page-download-utils.cjs");
const { runtimeOverrideEnv } = require("../ocr/host-services.cjs");
const { isOcrTransformersRuntime } = require("../ocr/runtime-device.cjs");

/** @typedef {import("../runtime-jsdoc-types").RuntimeOptions} RuntimeOptions */

/** @type {Readonly<Record<string, string>>} */
const PADDLE_OCR_LANG_BY_SOURCE_LANGUAGE = Object.freeze({
  ja: "japan",
  ko: "korean",
  en: "en",
  fr: "fr",
  de: "de",
  it: "it",
  es: "es",
  pt: "pt",
  ru: "ru",
  ar: "ar",
  fa: "fa",
  ur: "ur",
  hi: "hi",
  mr: "mr",
  ne: "ne",
  uk: "uk",
  bg: "bg",
  sr: "rs_cyrillic",
  be: "be",
  mn: "mn",
  ta: "ta",
  te: "te",
  ka: "ka",
  th: "th",
  el: "el",
  fil: "tl",
});

/** @type {Readonly<Record<string, string>>} */
const PADDLE_OCR_V5_RECOGNITION_PROFILES = Object.freeze({
  korean: "korean",
  th: "th",
  el: "el",
  te: "te",
  ta: "ta",
  ar: "arabic",
  fa: "arabic",
  ur: "arabic",
  ru: "eslav",
  uk: "eslav",
  be: "eslav",
  bg: "cyrillic",
  rs_cyrillic: "cyrillic",
  mn: "cyrillic",
  hi: "devanagari",
  mr: "devanagari",
  ne: "devanagari",
});

/** @param {unknown} value */
function isPaddleOcrModelAssetLoadFailure(value) {
  const text = stringifyErrorForDetection(value);
  return /json(?:\.|::)exception(?:\.|::)parse_error\.101|attempting to parse an empty input/i.test(
    text,
  );
}

/** @param {unknown} [reason] @param {RuntimeOptions} [options] */
function resolvePaddleOcrModelNamesForRepair(reason = "", options = {}) {
  const text = stringifyErrorForDetection(reason);
  const names = isOcrTransformersRuntime(options)
    ? resolveTransformersModelCacheNames(options)
    : PADDLE_OCR_MODEL_DOWNLOADS.map((model) => model.name);
  const explicit = names.filter(
    (name) =>
      text.includes(name) ||
      (name.endsWith("_safetensors") &&
        text.includes(name.slice(0, -"_safetensors".length))),
  );
  return explicit.length > 0 ? explicit : names;
}

/** @param {RuntimeOptions} options @returns {string[]} */
function resolveTransformersModelCacheNames(options) {
  const configuredDetectionName = resolveConfiguredModelName(
    options,
    "MANGA_TRANSLATOR_PADDLEOCR_TEXT_DETECTION_MODEL_NAME",
    options.ocrTextDetectionModelName,
  );
  const configuredRecognitionName = resolveConfiguredModelName(
    options,
    "MANGA_TRANSLATOR_PADDLEOCR_TEXT_RECOGNITION_MODEL_NAME",
    options.ocrTextRecognitionModelName,
  );
  const defaults = resolveDefaultTransformersModelNames(options);
  const configuredNames = [
    configuredDetectionName,
    configuredRecognitionName,
  ].filter(Boolean);
  const names = shouldUseConfiguredTransformersModelNames(
    defaults.version,
    configuredNames,
  )
    ? configuredNames
    : [defaults.detection, defaults.recognition];
  return names
    .filter(Boolean)
    .map(toSafetensorsName)
    .filter((name, index, names) => names.indexOf(name) === index);
}

/** @param {string} ocrVersion @param {string[]} configuredNames @returns {boolean} */
function shouldUseConfiguredTransformersModelNames(
  ocrVersion,
  configuredNames,
) {
  if (configuredNames.length === 0) {
    return false;
  }
  if (ocrVersion === "PP-OCRv6") {
    return true;
  }
  return !configuredNames.some((name) =>
    String(name).toLowerCase().includes("pp-ocrv6"),
  );
}

/** @param {RuntimeOptions} options @param {string} envKey @param {unknown} configured @returns {string} */
function resolveConfiguredModelName(options, envKey, configured) {
  return String(runtimeOverrideEnv(envKey, options) ?? configured ?? "").trim();
}

/** @param {RuntimeOptions} options @returns {{ detection: string; recognition: string; version: string }} */
function resolveDefaultTransformersModelNames(options) {
  const sourceLanguage = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_OCR_SOURCE_LANGUAGE", options) ??
      options.sourceLanguage ??
      "ja",
  );
  const lang = resolvePaddleOcrLanguage(sourceLanguage);
  const requestedVersion = String(
    runtimeOverrideEnv("MANGA_TRANSLATOR_PADDLEOCR_VERSION", options) ??
      options.ocrVersion ??
      "PP-OCRv6",
  ).trim();
  const version = resolvePaddleOcrVersion(lang, requestedVersion);
  if (version === "PP-OCRv5") {
    return { ...resolvePaddleOcrV5ModelNames(lang), version };
  }
  if (version === "PP-OCRv3") {
    return { ...resolvePaddleOcrV3ModelNames(lang), version };
  }
  if (version === "PP-OCRv4") {
    return { ...resolvePaddleOcrV4ModelNames(lang), version };
  }
  return {
    detection: "PP-OCRv6_medium_det",
    recognition: "PP-OCRv6_medium_rec",
    version,
  };
}

/** @param {string} sourceLanguage @returns {string} */
function resolvePaddleOcrLanguage(sourceLanguage) {
  const subtags = String(sourceLanguage || "ja")
    .trim()
    .toLowerCase()
    .split("-");
  const base = subtags[0] || "ja";
  if (base === "zh") {
    const traditional =
      subtags.includes("hant") ||
      subtags.some((subtag) => ["tw", "hk", "mo"].includes(subtag));
    return traditional ? "chinese_cht" : "ch";
  }
  return PADDLE_OCR_LANG_BY_SOURCE_LANGUAGE[base] || "en";
}

/** @param {string} lang @param {string} requestedVersion @returns {string} */
function resolvePaddleOcrVersion(lang, requestedVersion) {
  if (lang === "ka") {
    return "PP-OCRv3";
  }
  if (PADDLE_OCR_V5_RECOGNITION_PROFILES[lang]) {
    return "PP-OCRv5";
  }
  return requestedVersion || "PP-OCRv6";
}

/** @param {string} lang @returns {{ detection: string; recognition: string }} */
function resolvePaddleOcrV5ModelNames(lang) {
  const profile = PADDLE_OCR_V5_RECOGNITION_PROFILES[lang];
  const recognition = ["ch", "chinese_cht", "japan"].includes(lang)
    ? "PP-OCRv5_server_rec"
    : lang === "en"
      ? "en_PP-OCRv5_mobile_rec"
      : profile
        ? `${profile}_PP-OCRv5_mobile_rec`
        : "";
  return {
    detection: "PP-OCRv5_server_det",
    recognition,
  };
}

/** @param {string} lang @returns {{ detection: string; recognition: string }} */
function resolvePaddleOcrV4ModelNames(lang) {
  return {
    detection: "PP-OCRv4_mobile_det",
    recognition:
      lang === "ch"
        ? "PP-OCRv4_mobile_rec"
        : lang === "en"
          ? "en_PP-OCRv4_mobile_rec"
          : "",
  };
}

/** @param {string} lang @returns {{ detection: string; recognition: string }} */
function resolvePaddleOcrV3ModelNames(lang) {
  const profile = resolvePaddleOcrV3RecognitionProfile(lang);
  return {
    detection: "PP-OCRv3_mobile_det",
    recognition:
      profile === "ch"
        ? "PP-OCRv3_mobile_rec"
        : profile
          ? `${profile}_PP-OCRv3_mobile_rec`
          : "",
  };
}

/** @param {string} lang @returns {string} */
function resolvePaddleOcrV3RecognitionProfile(lang) {
  if (
    ["ch", "en", "korean", "japan", "chinese_cht", "te", "ka", "ta"].includes(
      lang,
    )
  ) {
    return lang;
  }
  return PADDLE_OCR_V5_RECOGNITION_PROFILES[lang] || "";
}

/** @param {string} modelName @returns {string} */
function toSafetensorsName(modelName) {
  return modelName.endsWith("_safetensors")
    ? modelName
    : `${modelName}_safetensors`;
}

/** @param {string} runtimeDir @param {string} modelDir */
function isSafePaddleOcrModelCacheDir(runtimeDir, modelDir) {
  const root = path.resolve(runtimeDir, "paddlex-cache", "official_models");
  const relative = path.relative(root, path.resolve(modelDir));
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/** @param {string} filePath @param {string} [fileName] */
function inspectPaddleOcrAssetFile(filePath, fileName = "") {
  if (!existsSync(filePath)) return null;
  const size = getFileSize(filePath);
  if (size <= 0) return "empty";
  const head = readFileHead(filePath, Math.min(size, 4096));
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1/m.test(head))
    return "git-lfs-pointer";
  return String(fileName || filePath)
    .toLowerCase()
    .endsWith(".json")
    ? inspectJsonFile(filePath)
    : null;
}

/** @param {string} filePath */
function inspectJsonFile(filePath) {
  try {
    JSON.parse(readFileSync(filePath, "utf8"));
    return null;
  } catch (error) {
    return `invalid-json: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** @param {string} filePath @param {number} maxLength */
function readFileHead(filePath, maxLength) {
  let fd = null;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(Math.max(0, maxLength));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (_error) {
    return "";
  } finally {
    closeFileDescriptor(fd);
  }
}

/** @param {number | null} fd */
function closeFileDescriptor(fd) {
  if (fd === null) return;
  try {
    closeSync(fd);
  } catch (_error) {
    // error-policy-allow: cache validation reports the primary read result, not a close failure.
  }
}

/** @param {unknown} value */
function stringifyErrorForDetection(value) {
  if (!value || typeof value !== "object") return String(value ?? "");
  const record =
    /** @type {{ message?: unknown; stderrPreview?: unknown; stdoutPreview?: unknown; cause?: unknown }} */ (
      value
    );
  return [
    record.message,
    record.stderrPreview,
    record.stdoutPreview,
    record.cause,
  ]
    .filter(Boolean)
    .map((part) => String(part))
    .join(" ");
}

/** @param {unknown} value @param {number} [maxLength] */
function truncateReason(value, maxLength = 500) {
  const text = stringifyErrorForDetection(value).replace(/\s+/g, " ").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

module.exports = {
  inspectPaddleOcrAssetFile,
  isPaddleOcrModelAssetLoadFailure,
  isSafePaddleOcrModelCacheDir,
  resolvePaddleOcrModelNamesForRepair,
  truncateReason,
};
