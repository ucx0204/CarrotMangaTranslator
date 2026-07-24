const { readFile } = require("node:fs/promises");
const path = require("node:path");

/**
 * @typedef {{ pattern: number; other: number }} BlockTypeCounts
 * @typedef {{ modelProvider?: string; gemmaVramMode?: unknown; modelRepo?: unknown; modelFile?: unknown; mmprojRepo?: unknown; mmprojFile?: unknown; ctx?: unknown; batch?: unknown; ubatch?: unknown; kvOffload?: unknown; mmprojOffload?: unknown; fitTargetMb?: unknown; useDraft?: unknown; imageMinTokens?: unknown; imageMaxTokens?: unknown; codexModel?: unknown; codexReasoningEffort?: unknown; ocrBboxHints?: unknown; serverLogPath?: string; label?: string; imagePath?: string; imageWidth?: number; imageHeight?: number; outputDir?: string; abortSignal?: AbortSignal; [key: string]: unknown }} SmokeOptions
 */

/** @param {Array<{ sourceType?: string; type?: string }>} blocks */
function countBlockTypes(blocks) {
  return blocks.reduce((counts, block) => {
    if (block.sourceType === "pattern" || block.type === "pattern") {
      counts.pattern += 1;
    } else {
      counts.other += 1;
    }
    return counts;
  }, /** @type {BlockTypeCounts} */ ({ pattern: 0, other: 0 }));
}

/** @param {SmokeOptions} options @returns {SmokeOptions} */
function applySmokeOptionOverrides(options) {
  const overridden = { ...options };
  setStringOption(overridden, "modelRepo", "MANGA_SMOKE_MODEL_REPO");
  setStringOption(overridden, "modelFile", "MANGA_SMOKE_MODEL_FILE");
  setStringOption(overridden, "mmprojRepo", "MANGA_SMOKE_MMPROJ_REPO");
  setStringOption(overridden, "mmprojFile", "MANGA_SMOKE_MMPROJ_FILE");
  setStringOption(overridden, "codexModel", "MANGA_SMOKE_CODEX_MODEL");
  setStringOption(
    overridden,
    "codexReasoningEffort",
    "MANGA_SMOKE_CODEX_REASONING_EFFORT",
  );
  setNumberOption(overridden, "ctx", "MANGA_SMOKE_CTX");
  setNumberOption(overridden, "batch", "MANGA_SMOKE_BATCH");
  setNumberOption(overridden, "ubatch", "MANGA_SMOKE_UBATCH");
  setNumberOption(overridden, "fitTargetMb", "MANGA_SMOKE_FIT_TARGET_MB");
  setNumberOption(overridden, "imageMinTokens", "MANGA_SMOKE_IMAGE_MIN_TOKENS");
  setNumberOption(overridden, "imageMaxTokens", "MANGA_SMOKE_IMAGE_MAX_TOKENS");
  setBooleanOption(overridden, "kvOffload", "MANGA_SMOKE_KV_OFFLOAD");
  setBooleanOption(overridden, "mmprojOffload", "MANGA_SMOKE_MMPROJ_OFFLOAD");
  setBooleanOption(overridden, "useDraft", "MANGA_SMOKE_USE_DRAFT");
  return overridden;
}

/** @param {SmokeOptions} target @param {string} key @param {string} envName */
function setStringOption(target, key, envName) {
  const value = String(process.env[envName] || "").trim();
  if (value) target[key] = value;
}

/** @param {SmokeOptions} target @param {string} key @param {string} envName */
function setNumberOption(target, key, envName) {
  const raw = String(process.env[envName] || "").trim();
  if (!raw) return;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${envName} must be a finite number.`);
  }
  target[key] = value;
}

/** @param {SmokeOptions} target @param {string} key @param {string} envName */
function setBooleanOption(target, key, envName) {
  const raw = String(process.env[envName] || "")
    .trim()
    .toLowerCase();
  if (!raw) return;
  if (["1", "true", "yes", "on"].includes(raw)) target[key] = true;
  else if (["0", "false", "no", "off"].includes(raw)) target[key] = false;
  else throw new Error(`${envName} must be true/false or 1/0.`);
}

/** @param {string} rootDir @param {number} pageIndex */
async function readReusableOcrHints(rootDir, pageIndex) {
  const candidates = [
    path.join(rootDir, `page-${pageIndex}`, "ocr-hints.json"),
    path.join(rootDir, `page-${pageIndex + 1}`, "ocr-hints.json"),
  ];
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(await readFile(candidate, "utf8"));
      const record =
        payload && typeof payload === "object"
          ? /** @type {{ items?: unknown; hints?: unknown }} */ (payload)
          : {};
      if (Array.isArray(record.items)) return record.items;
      if (Array.isArray(record.hints)) return record.hints;
      throw new Error(
        `Reusable OCR file has no items/hints array: ${candidate}`,
      );
    } catch (error) {
      if (isMissingFileError(error)) continue;
      throw error;
    }
  }
  return undefined;
}

/** @param {unknown} error */
function isMissingFileError(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    /** @type {{ code?: unknown }} */ (error).code === "ENOENT"
  );
}

module.exports = {
  applySmokeOptionOverrides,
  countBlockTypes,
  readReusableOcrHints,
};
