// @ts-check

const { readPositiveInteger } = require("../prompts/common.cjs");
const {
  convertOriginalPixelBoxToPromptFrame,
  resolvePromptCoordinateFrame,
} = require("../prompts/coordinates.cjs");
const {
  readOcrCandidateText,
  sanitizeOcrTextForPrompt,
} = require("../prompts/ocr-text.cjs");
const {
  isJapaneseLanguageCode,
} = require("../simple-page-language-profile.cjs");
const {
  MAX_OCR_CANDIDATES,
  positiveInteger,
  semanticContractError,
} = require("./values.cjs");

const COMMON_SEMANTIC_OCR_QUALITY_MODES = new Set([
  "minimum",
  "economy",
  "full",
]);

/**
 * @typedef {{ id: number; bbox: [number, number, number, number]; text: string; score: number | null; group?: string; order?: number; orientation: "horizontal" | "vertical"; soundCandidate:boolean }} SemanticCandidate
 * @typedef {{ sourceLanguage?: unknown; imageWidth?: unknown; imageHeight?: unknown; ocrBboxHints?: unknown; [key: string]: unknown }} SemanticOptions
 * @typedef {{ role: string; dataUrl?: string; width?: unknown; height?: unknown; originalWidth?: unknown; originalHeight?: unknown; [key: string]: unknown }} ImageVariant
 */

/**
 * @param {SemanticOptions} options
 * @param {ImageVariant[]} imageVariants
 * @returns {SemanticCandidate[]}
 */
function buildSemanticCandidates(options, imageVariants = []) {
  const hints = Array.isArray(options.ocrBboxHints) ? options.ocrBboxHints : [];
  const promptOptions =
    /** @type {import("../prompts/prompt-types").PromptOptions} */ (options);
  const context = {
    frame: resolvePromptCoordinateFrame(promptOptions, imageVariants),
    originalWidth: readPositiveInteger(options.imageWidth),
    originalHeight: readPositiveInteger(options.imageHeight),
    promptOptions,
    usedIds: new Set(),
  };
  /** @type {SemanticCandidate[]} */
  const candidates = [];
  for (const [index, hint] of hints.entries()) {
    const candidate = buildSemanticCandidate(hint, index, context);
    // The common semantic path is a grouping/translation pass over PaddleOCR
    // evidence, not a second free-form OCR detector. A geometry-only box has
    // no lexical anchor and allowed no-text art to become invented dialogue.
    if (
      candidate &&
      hasLexicalEvidence(candidate.text) &&
      !isLowConfidenceJapaneseAsciiArtifact(candidate, options.sourceLanguage)
    ) {
      candidates.push(candidate);
    }
  }
  assertCandidateLimit(candidates.length);
  return candidates;
}

/**
 * Medium OCR can occasionally turn decorative strokes into a short ASCII
 * word on Japanese pages. Keep the filter deliberately narrow: real signs
 * with strong confidence, non-ASCII text, explicit SFX, and other source
 * languages continue through the semantic pass.
 *
 * @param {SemanticCandidate} candidate
 * @param {unknown} sourceLanguage
 */
function isLowConfidenceJapaneseAsciiArtifact(candidate, sourceLanguage) {
  return (
    isJapaneseLanguageCode(sourceLanguage) &&
    !candidate.soundCandidate &&
    candidate.score !== null &&
    candidate.score < 0.82 &&
    /^[A-Za-z]+$/.test(candidate.text.trim())
  );
}

/**
 * Quality presets own the pipeline boundary. Keep mergeMode as a compatibility
 * fallback only for older direct callers that do not provide a quality mode.
 * @param {SemanticOptions} options
 */
function isCommonSemanticOcrMode(options = {}) {
  const quality = String(options.ocrQualityMode ?? "")
    .trim()
    .toLowerCase();
  if (COMMON_SEMANTIC_OCR_QUALITY_MODES.has(quality)) return true;
  return (
    String(options.ocrMergeMode ?? "")
      .trim()
      .toLowerCase() === "semantic"
  );
}

/** @param {unknown} value */
function hasLexicalEvidence(value) {
  return /[\p{L}\p{N}]/u.test(String(value ?? ""));
}

/** @param {number} count */
function assertCandidateLimit(count) {
  if (count <= MAX_OCR_CANDIDATES) return;
  throw semanticContractError(
    "semantic-ocr-candidate-limit",
    `Semantic OCR supports at most ${MAX_OCR_CANDIDATES} candidates per page.`,
  );
}

/**
 * @param {unknown} rawHint
 * @param {number} index
 * @param {{frame: import("../prompts/prompt-types").PromptCoordinateFrame; originalWidth: number | null; originalHeight: number | null; promptOptions: import("../prompts/prompt-types").PromptOptions; usedIds: Set<number>}} context
 * @returns {SemanticCandidate | null}
 */
function buildSemanticCandidate(rawHint, index, context) {
  if (!rawHint || typeof rawHint !== "object" || Array.isArray(rawHint)) {
    return null;
  }
  const hint = /** @type {Record<string, unknown>} */ (rawHint);
  const rawBox = readHintBox(hint);
  if (!rawBox) return null;
  const id = positiveInteger(hint.id);
  if (!id) {
    throw semanticContractError(
      "semantic-ocr-candidate-id-invalid",
      `Semantic OCR candidate ${index + 1} is missing a stable positive id.`,
    );
  }
  assertUniqueCandidateId(id, context.usedIds);
  const converted = convertOriginalPixelBoxToPromptFrame(
    rawBox,
    context.frame,
    context.originalWidth,
    context.originalHeight,
  );
  const score = Number(hint.score);
  const group = normalizeGroupId(hint.groupId);
  const order = readPositiveInteger(hint.orderInGroup);
  return {
    id,
    bbox: [converted.x1, converted.y1, converted.x2, converted.y2],
    text: sanitizeOcrTextForPrompt(
      readOcrCandidateText(hint),
      context.promptOptions,
    ),
    score: Number.isFinite(score) ? Math.round(score * 10000) / 10000 : null,
    ...(group ? { group } : {}),
    ...(order ? { order } : {}),
    orientation:
      rawBox.y2 - rawBox.y1 > (rawBox.x2 - rawBox.x1) * 1.25
        ? "vertical"
        : "horizontal",
    soundCandidate: isSoundCandidateHint(hint),
  };
}

/** @param {Record<string, unknown>} hint */
function isSoundCandidateHint(hint) {
  const role = String(hint.textRole ?? hint.role ?? hint.kind ?? "")
    .trim()
    .toLowerCase();
  const label = String(hint.label ?? "")
    .trim()
    .toLowerCase();
  return (
    role === "sound" ||
    role === "sfx" ||
    label.includes("sfx") ||
    label.includes("sound_effect")
  );
}

/** @param {number} id @param {Set<number>} usedIds */
function assertUniqueCandidateId(id, usedIds) {
  if (usedIds.has(id)) {
    throw semanticContractError(
      "semantic-ocr-candidate-id-duplicate",
      `Semantic OCR received duplicate candidate id ${id}.`,
    );
  }
  usedIds.add(id);
}

/** @param {Record<string, unknown>} hint */
function readHintBox(hint) {
  const x1 = Number(hint.x1);
  const y1 = Number(hint.y1);
  const x2 = Number(hint.x2);
  const y2 = Number(hint.y2);
  return [x1, y1, x2, y2].every(Number.isFinite) && x2 > x1 && y2 > y1
    ? { x1, y1, x2, y2 }
    : null;
}

/** @param {unknown} value */
function normalizeGroupId(value) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  return /^G\d{3,4}$/.test(normalized) ? normalized : "";
}

module.exports = {
  buildSemanticCandidates,
  isCommonSemanticOcrMode,
};
