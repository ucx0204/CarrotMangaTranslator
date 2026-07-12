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

/** @param {unknown} value */
function isPaddleOcrModelAssetLoadFailure(value) {
  const text = stringifyErrorForDetection(value);
  return /json\.exception\.parse_error\.101|attempting to parse an empty input|Creating model:\s*\('?(PP-DocLayoutV3|PaddleOCR-VL-1\.[56]|PP-OCRv[56]_(server|medium)_det|PP-OCRv[56]_(server|medium)_rec)/i.test(
    text,
  );
}

/** @param {unknown} [reason] */
function resolvePaddleOcrModelNamesForRepair(reason = "") {
  const text = stringifyErrorForDetection(reason);
  const explicit = PADDLE_OCR_MODEL_DOWNLOADS.map((model) => model.name).filter(
    (name) => text.includes(name),
  );
  return explicit.length > 0
    ? explicit
    : PADDLE_OCR_MODEL_DOWNLOADS.map((model) => model.name);
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
