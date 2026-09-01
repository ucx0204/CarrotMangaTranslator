// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */
/** @typedef {import("./prompt-types").ImageVariant} ImageVariant */
/** @typedef {import("./prompt-types").PromptSection} PromptSection */
/** @typedef {import("./prompt-types").PromptCoordinateFrame} PromptCoordinateFrame */
/** @typedef {import("./prompt-types").OcrHint} OcrHint */

const { readPositiveInteger } = require("./common.cjs");
const {
  convertOriginalPixelBoxToPromptFrame,
  resolvePromptCoordinateFrame,
} = require("./coordinates.cjs");
const {
  SMALL_GEMMA_OCR_ANCHOR_LINES,
  SMALL_GEMMA_OCR_DUPLICATE_LINES,
  shouldUseSmallGemmaDuplicatePromptProfile,
} = require("./model-profile.cjs");
const {
  buildOcrGroupContextLines,
  sanitizeOcrGroupId,
  sanitizeOcrGroupValue,
} = require("./ocr-groups.cjs");
const {
  readOcrCandidateText,
  sanitizeHintLabel,
  sanitizeOcrTextForPrompt,
} = require("./ocr-text.cjs");
const { isHayaiOcrPipeline } = require("../ocr/engine-profile.cjs");

/**
 * @typedef {{
 *   candidateIds: number[];
 *   formattedHints: string[];
 *   groupContextLines: PromptSection;
 *   maxCandidateId: number;
 * }} PreparedOcrHints
 * @typedef {{
 *   candidateChangeLine: string;
 *   keepBlocksMode: boolean;
 *   missingTextIntroLines: string[];
 *   ocrAnchorLines: string[];
 *   useStrictDuplicateRules: boolean;
 * }} OcrHintPolicy
 */

/**
 * @param {PromptOptions} [options]
 * @param {ImageVariant[]} [imageVariants]
 * @returns {PromptSection}
 */
function buildOcrBboxHintSection(options = {}, imageVariants = []) {
  const prepared = prepareOcrHints(options, imageVariants);
  if (!prepared) {
    return [];
  }
  if (isHayaiOcrPipeline(options)) {
    return buildHayaiRegionSectionLines(prepared);
  }
  const policy = buildOcrHintPolicy(options, prepared.maxCandidateId);
  return buildOcrBboxSectionLines(prepared, policy);
}

/**
 * The text detector has already produced complete ordinary-text regions. Hayai supplies
 * reading hints only; the model translates each immutable slot independently.
 * @param {PreparedOcrHints} prepared
 * @returns {PromptSection}
 */
function buildHayaiRegionSectionLines(prepared) {
  return [
    "Locked ordinary-text regions (HayaiOCR)",
    "The app has already separated and finalized every ordinary dialogue, narration, caption, note, sign, and label region. Standalone sound effects are deliberately excluded from this list and handled by a separate user review layer.",
    "Treat every candidate as one immutable output slot. Never merge candidates, split a candidate, move a candidate, enlarge a candidate, or assign one candidate's text to another candidate.",
    "For every accepted candidate, output exactly one record with the same id and the exact x1, y1, x2, y2 values below. Never output candidateIds containing another id.",
    "Set type to nonsolid and textRole to ordinary for every accepted candidate. Do not classify any supplied candidate as sound.",
    "Hayai OCR text is a reading hint, not geometry authority. Re-read Image 1 to correct recognition errors, ruby/furigana noise, and punctuation, but read only the visible text inside that candidate rectangle plus a tiny visual margin.",
    "Do not add records with new ids. Do not search outside the supplied candidates for missing text or sound effects. Decorative marks, patterns, panel lines, and standalone SFX must not be introduced as translation records.",
    "Do not combine separate speech balloons even when their sentences continue. The region detector has intentionally preserved them as separate slots.",
    "Translate every readable main line inside each candidate. Use furigana only as pronunciation help and translate the main term once.",
    `Candidate ids to translate independently: ${prepared.candidateIds.join(", ")}.`,
    "The candidate coordinates below are already converted into the exact output coordinate frame.",
    "",
    ...prepared.formattedHints,
  ];
}

/**
 * @param {PromptOptions} options
 * @param {ImageVariant[]} imageVariants
 * @returns {PreparedOcrHints | null}
 */
function prepareOcrHints(options, imageVariants) {
  const hints = Array.isArray(options.ocrBboxHints) ? options.ocrBboxHints : [];
  if (hints.length === 0) {
    return null;
  }
  const frame = resolvePromptCoordinateFrame(options, imageVariants);
  const originalWidth = readPositiveInteger(options.imageWidth);
  const originalHeight = readPositiveInteger(options.imageHeight);
  const formattedHints = hints
    .slice(0, 80)
    .map((hint, index) =>
      formatOcrBboxHintForPrompt(
        hint,
        index + 1,
        frame,
        originalWidth,
        originalHeight,
        options,
      ),
    )
    .filter(Boolean);
  if (formattedHints.length === 0) {
    return null;
  }
  const usedHints = hints.slice(0, formattedHints.length);
  const candidateIds = usedHints.map(
    (hint, index) => readPositiveInteger(hint.id) || index + 1,
  );
  return {
    candidateIds,
    formattedHints,
    groupContextLines: buildOcrGroupContextLines(usedHints, options),
    maxCandidateId: Math.max(...candidateIds, 0),
  };
}

/**
 * @param {PromptOptions} options
 * @param {number} maxCandidateId
 * @returns {OcrHintPolicy}
 */
function buildOcrHintPolicy(options, maxCandidateId) {
  const strictRefineMode = Boolean(options.strictRefineMode);
  const keepBlocksMode = Boolean(options.keepBlocksMode);
  const smallGemma = shouldUseSmallGemmaDuplicatePromptProfile(options);
  const useStrictDuplicateRules = strictRefineMode || smallGemma;
  return {
    candidateChangeLine: selectCandidateChangeLine(
      keepBlocksMode,
      useStrictDuplicateRules,
    ),
    keepBlocksMode,
    missingTextIntroLines: selectMissingTextIntroLines(
      keepBlocksMode,
      strictRefineMode,
      smallGemma,
      maxCandidateId,
    ),
    ocrAnchorLines: useStrictDuplicateRules
      ? SMALL_GEMMA_OCR_ANCHOR_LINES
      : [
          "OCR text hints may be wrong, incomplete, or split strangely. Use Image 1 as the authority for the actual Japanese text and Korean translation.",
          "Use the OCR text hint to keep each translated record attached to the correct candidate id, especially when nearby candidates are close together.",
        ],
    useStrictDuplicateRules,
  };
}

/**
 * @param {boolean} keepBlocksMode
 * @param {boolean} useStrictDuplicateRules
 * @returns {string}
 */
function selectCandidateChangeLine(keepBlocksMode, useStrictDuplicateRules) {
  if (keepBlocksMode) {
    return "Never change a candidate bbox: output the exact x1, y1, x2, y2 numbers shown below for each candidate id.";
  }
  return useStrictDuplicateRules
    ? "You may change a candidate bbox only when Image 1 clearly proves the candidate clips visible glyph strokes, includes non-text art, or must be merged with adjacent same-container candidates; then change the minimum amount needed and keep the representative candidate id."
    : "You may change a candidate bbox only when Image 1 clearly proves the candidate clips visible glyph strokes, includes non-text art, or must be merged with adjacent same-container candidates; then change the minimum amount needed.";
}

/**
 * @param {boolean} keepBlocksMode
 * @param {boolean} strictRefineMode
 * @param {boolean} smallGemma
 * @param {number} maxCandidateId
 * @returns {string[]}
 */
function selectMissingTextIntroLines(
  keepBlocksMode,
  strictRefineMode,
  smallGemma,
  maxCandidateId,
) {
  if (keepBlocksMode) {
    return [
      "The candidates are user-defined block slots and the complete set of output slots. Never add a record with a new id, even for clearly visible Japanese text outside every candidate rectangle.",
    ];
  }
  if (strictRefineMode) {
    return [
      "In strict refinement, OCR candidates are the main output slots. After processing candidates, inspect Image 1 only for obvious missing Japanese text that is fully outside all candidate rectangles.",
      `If the detector missed visible Japanese text, add a new record with id greater than ${maxCandidateId}. New ids are exceptional and must never correct, restate, enlarge, or duplicate an existing candidate.`,
      "A new record is invalid if its bbox overlaps an OCR candidate, its center sits inside an OCR candidate, or its jp repeats text already assigned to a candidate or earlier record.",
      "For new missing SFX records, be very conservative: add them only when the complete kana/SFX glyph group is clearly visible, fully outside every candidate, the exact source reading is clear, and the Korean sound choice is certain enough for confidence 1.00.",
      "Never add new ordinary records for dots, dashes, ellipses, Latin letters, digits, UI fragments, panel trim, furniture lines, wall patterns, or isolated strokes.",
    ];
  }
  if (smallGemma) {
    return [
      "OCR candidates are the normal source of output records. After processing candidates, inspect Image 1 only for obvious missing Japanese text that is clearly outside all candidate rectangles.",
      `If the detector missed visible Japanese text, add a new record with id greater than ${maxCandidateId}. Never reuse a candidate id for missing text outside that candidate rectangle, and never add a new id for text already covered by a candidate.`,
      "New records are allowed only for clear Japanese glyphs whose bbox does not overlap existing candidate rectangles except for a tiny edge touch.",
      "For new missing SFX records, be conservative: add them only when the complete kana/SFX glyph group is clearly visible and not covered by any candidate. The bbox must visibly cover kana/SFX glyph strokes.",
    ];
  }
  return [
    "OCR candidates are a floor, not a ceiling. After processing candidates, inspect the whole Image 1 again for missing Japanese text.",
    `If the detector missed visible Japanese text, add a new record with id greater than ${maxCandidateId}. Never reuse a candidate id for missing text outside that candidate rectangle.`,
    "New records are allowed only for clear Japanese glyphs that are not covered by any candidate.",
    "For new missing SFX records, search especially near character bodies, panel edges, and lower panels where OCR often misses gray or outlined kana. The bbox must visibly cover kana/SFX glyph strokes.",
  ];
}

/**
 * @param {PreparedOcrHints} prepared
 * @param {OcrHintPolicy} policy
 * @returns {PromptSection}
 */
function buildOcrBboxSectionLines(prepared, policy) {
  const mergeLine = policy.keepBlocksMode
    ? "No merge exception applies: the candidates are user-defined block slots, so adjacent, touching, or same-container candidates always stay separate records with their own ids."
    : "Same-container merge exception: if adjacent ordinary candidates are clearly separate OCR slices of one speech bubble, caption, note, sign, or label, output one merged ordinary record using the first candidate id in Japanese reading order. Its jp must include all visible source text from the merged candidates, its ko must translate the combined expression naturally, and the swallowed candidate ids must not be output separately. Do not import words from previous pass or story memory that are not visible in the corrected merged jp.";
  const readingLine = policy.keepBlocksMode
    ? "Read and translate only the text inside that candidate rectangle plus a tiny visual margin. Do not move the rectangle to a different nearby text group."
    : "Read and translate only the text inside that candidate rectangle plus a tiny visual margin, except for the same-container merge exception above. Do not move the rectangle to a different nearby text group.";
  return [
    "OCR bbox candidates",
    "An external OCR geometry detector has already proposed bbox candidates. Some candidates include low-trust OCR text hints for slot matching only.",
    ...policy.ocrAnchorLines,
    "Treat each candidate as a geometry anchor. Normally, for every candidate that contains Japanese glyphs, output one record with that same id and the exact x1, y1, x2, y2 numbers shown below.",
    mergeLine,
    ...(policy.useStrictDuplicateRules
      ? [SMALL_GEMMA_OCR_DUPLICATE_LINES[0]]
      : []),
    `Candidate ids to review: ${prepared.candidateIds.join(", ")}.`,
    ...prepared.groupContextLines,
    readingLine,
    ...(policy.useStrictDuplicateRules
      ? SMALL_GEMMA_OCR_DUPLICATE_LINES.slice(1)
      : []),
    "For each candidate, read every visible Japanese line inside the rectangle. A candidate record is incomplete if jp or ko contains only the first line while lower or side lines remain readable.",
    "OCR hints may include Latin garbage, OCR-recognized furigana/ruby, romanized readings, duplicated aliases, or stray syllables mixed into the main text. Re-read Image 1 and translate the visible main Japanese text; use furigana only as pronunciation help, not as extra words or names.",
    "If OCR or previous jp contains Latin letters or odd katakana inside ordinary Japanese dialogue and Image 1 does not show those glyphs as main text, treat them as OCR noise. Do not translate them into names, aliases, or Korean words.",
    "When a term has kanji with furigana, translate the main term once. If the glossary contains the kanji term or its alias, prefer the glossary target over OCR hint spelling, story memory spelling, or previous Korean wording.",
    "Do not turn a visible kana sequence into a more common-looking phrase from previous context. Preserve the actual kana order; for example, どいつもこいつも means every one of them/all alike, not いつも (always) or こいつと (with this one).",
    "If a candidate is a handwritten note or diagram label, preserve all readable words, but translate ko compactly for horizontal Korean reading rather than copying the Japanese vertical line breaks.",
    "For every accepted candidate, output type nonsolid and set textRole to ordinary or sound.",
    "If a candidate is a sweat drop, texture, decoration, panel trim, or other non-text mark, skip it instead of inventing text.",
    "For candidate SFX, confidence is below 1.00 by default. Use confidence 1.00 only when the complete effect text is clearly read and the Korean sound choice is clearly right; otherwise use confidence below 1.00 so the app drops it.",
    policy.candidateChangeLine,
    "Do not merge two separate speech bubbles into one record, even when the sentence continues across them. Separate balloon lobes, stacked bubbles, captions, UI rows, and unrelated nearby text stay separate.",
    "If two candidates are stacked or touching speech bubbles rather than columns inside one container, output two separate dialogue records with their original ids.",
    "For phone/game/menu UI candidates: keep only compact labels such as MENU, Quests, SAVE, or DELETE when they fit the candidate. Do not translate a multi-row UI list or save-slot table as one large Korean block.",
    "For containerType ui_list, phone_ui, menu, settings, or game_ui: keep each candidate compact, treat it as an ordinary UI label, and never create a large new dialogue record covering the UI panel or list.",
    ...policy.missingTextIntroLines,
    "Never add SFX on panel trim, furniture lines, wall patterns, or isolated vertical strokes.",
    "The candidate coordinates below are already converted into the same coordinate frame required for your output.",
    "",
    ...prepared.formattedHints,
  ];
}

/**
 * @param {OcrHint} hint
 * @param {number} fallbackId
 * @param {PromptCoordinateFrame} frame
 * @param {number | null} originalWidth
 * @param {number | null} originalHeight
 * @param {PromptOptions} [options]
 * @returns {string}
 */
function formatOcrBboxHintForPrompt(
  hint,
  fallbackId,
  frame,
  originalWidth,
  originalHeight,
  options = {},
) {
  const box = readHintBox(hint);
  if (!box) {
    return "";
  }

  const id = readPositiveInteger(hint.id) || fallbackId;
  const label = sanitizeHintLabel(hint.label);
  const converted = convertOriginalPixelBoxToPromptFrame(
    box,
    frame,
    originalWidth,
    originalHeight,
  );
  const score = formatHintScore(hint.score);
  const textHint = formatOcrTextHint(hint, options);
  const group = formatHintGroup(hint);
  const role = formatHintValue("rolePrior", hint.rolePrior);
  const container = formatHintValue("containerType", hint.containerType);
  return `candidate ${id}: label:${label} x1:${converted.x1} y1:${converted.y1} x2:${converted.x2} y2:${converted.y2}${score}${group}${role}${container}${textHint}`;
}

/** @param {OcrHint} hint @returns {import("./prompt-types").PromptBox | null} */
function readHintBox(hint) {
  const box = {
    x1: Number(hint?.x1),
    y1: Number(hint?.y1),
    x2: Number(hint?.x2),
    y2: Number(hint?.y2),
  };
  return Object.values(box).every(Number.isFinite) ? box : null;
}

/** @param {unknown} value @returns {string} */
function formatHintScore(value) {
  const score = Number(value);
  return Number.isFinite(score)
    ? ` score:${Math.round(score * 100) / 100}`
    : "";
}

/** @param {OcrHint} hint @param {PromptOptions} options @returns {string} */
function formatOcrTextHint(hint, options) {
  const text = sanitizeOcrTextForPrompt(readOcrCandidateText(hint), options);
  return text ? ` ocrText:${JSON.stringify(text)}` : "";
}

/** @param {OcrHint} hint @returns {string} */
function formatHintGroup(hint) {
  const groupId = sanitizeOcrGroupId(hint.groupId);
  if (!groupId) {
    return "";
  }
  return ` group:${groupId} orderInGroup:${readPositiveInteger(hint.orderInGroup) || 1}`;
}

/** @param {string} key @param {unknown} value @returns {string} */
function formatHintValue(key, value) {
  const sanitized = sanitizeOcrGroupValue(value);
  return sanitized ? ` ${key}:${sanitized}` : "";
}

module.exports = { buildOcrBboxHintSection };
