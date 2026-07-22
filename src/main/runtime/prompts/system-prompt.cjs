// @ts-check
/** @typedef {import("./prompt-types").PromptOptions} PromptOptions */

const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");
const { localizePromptTextForProfile } = require("./localization.cjs");

/**
 * @param {PromptOptions} [options]
 * @returns {string}
 */
function buildSystemPrompt(options = {}) {
  const languageProfile = resolvePromptLanguageProfile(options);
  if (hasSelectedBlockTranslationSource(options)) {
    return localizePromptTextForProfile(
      [
        "You are translating one selected existing manga text block.",
        "The authoritative sourceText is supplied in the user prompt. Translate exactly that sourceText; do not OCR, re-read, correct, extend, merge, or replace it from Image 1.",
        "Image 1, glossary, character notes, and story memory are context only. They may resolve names, pronouns, tone, honorifics, and ambiguity, but must never add source meaning, events, objects, or dialogue absent from the authoritative sourceText.",
        "Return only one machine-readable record in the format requested by the user prompt.",
        "Keep the selected block id and geometry stable.",
      ].join("\n\n"),
      languageProfile,
    );
  }
  if (options.regionCropMode) {
    return localizePromptTextForProfile(
      [
        "You are an OCR and manga-translation engine.",
        "Return only the single JSON object format requested by the user prompt.",
        "Image 1 is the coordinate authority. Geometry accuracy comes before Korean text fit.",
        "Use the full-page context image, glossary, and story memory only to understand speaker, tone, terms, and continuity for the visible Japanese inside Image 1.",
        "Render ordinary speech, captions, labels, and notes in natural horizontal Korean by default.",
      ].join("\n\n"),
      languageProfile,
    );
  }

  const lines = [
    "You are an OCR and manga-translation engine.",
    "Return only the machine-readable record format requested by the user prompt.",
    "Geometry accuracy comes before Korean text fit: preserve the original Japanese glyph position and apparent size.",
    "Never merge separate speech bubbles, including touching or stacked balloon lobes.",
    "Never output duplicate or overlapping records for the same physical Japanese text area. One glyph cluster/container must become one record, not stacked blocks.",
    "Render ordinary speech/caption/label Korean horizontally by default; source Japanese vertical direction is not a reason to make Korean vertical.",
    "For SFX records, output bare Korean effect lettering only; do not wrap it in parentheses/brackets/quotes or turn it into a stage direction.",
    "For SFX records, choose compact Korean effect lettering that fits the scene and rhythm. Do not mechanically transliterate Japanese kana, and do not force ambient sounds into dialogue words or action descriptions.",
    "For SFX records, confidence is below 1.00 by default. Use confidence 1.00 only when the complete sound effect is unquestionably real Japanese text, fully read, and clearly translated into a fitting Korean sound; otherwise use confidence below 1.00 so the app drops it.",
  ];

  if (options.strictRefineMode) {
    lines.push(
      "Strict refinement pass: previous jp/ko blocks and story memory are weak review hints only, not source text. Keep ids and geometry stable, but aggressively correct OCR, ruby, and previous-translation mistakes in the existing record.",
      ...(options.keepBlocksMode
        ? [
            "Fixed-blocks pass: the OCR candidates are user-defined block slots. Output at most one record per candidate id, never merge candidates, and never invent a new id.",
          ]
        : [
            "If OCR split one speech bubble or caption into adjacent same-container candidates, merge those fragments into one ordinary record using the first reading-order candidate id.",
          ]),
      "If a previous block contains Latin garbage, romanized ruby, stray katakana, or wording not supported by the visible glyphs, discard that wording and re-read Image 1.",
      ...(options.keepBlocksMode
        ? []
        : [
            "In strict refinement, new ids are exceptional and valid only for complete visible Japanese glyph groups clearly outside every OCR candidate.",
          ]),
    );
  }

  if (options.regionCropMode) {
    lines.push(
      "Selected-region mode: group by visual text container, not by line or column. One speech bubble or one caption plate is one item even when the Japanese is split across multiple vertical columns or lines.",
    );
  }

  return localizePromptTextForProfile(lines.join("\n\n"), languageProfile);
}

/** @param {PromptOptions} options @returns {boolean} */
function hasSelectedBlockTranslationSource(options) {
  return (
    typeof options.selectedBlockTranslationSourceText === "string" &&
    options.selectedBlockTranslationSourceText.trim().length > 0
  );
}

module.exports = { buildSystemPrompt };
