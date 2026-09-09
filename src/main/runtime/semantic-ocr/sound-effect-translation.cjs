// @ts-check

const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");
const { buildWorkContextSection } = require("../prompts/work-context.cjs");

const { buildSystemPrompt } = require("../prompts/system-prompt.cjs");
const { buildRegionTaskSection } = require("../prompts/task-sections.cjs");
const { localizePromptTextForProfile } = require("../prompts/localization.cjs");

const SOUND_EFFECT_TRANSLATION_CONTRACT_VERSION = 3;

/** @param {Record<string, unknown>} options */
function buildSoundEffectTranslationSystemPrompt(options) {
  return buildSystemPrompt({ ...options, regionCropMode: true });
}

/**
 * @param {Record<string, unknown>} options
 * @param {import("../prompts/prompt-types").ImageVariant[]} [imageVariants]
 */
function buildSoundEffectTranslationPrompt(options, imageVariants = []) {
  const language = resolvePromptLanguageProfile(options);
  const target = readSoundEffectTarget(options);
  const attempt = Number(options.translationAttempt) || 1;
  const retryFeedback = readRetryFeedback(options.soundEffectRetryFeedback);
  const regionOptions = { ...options, regionCropMode: true };
  return localizePromptTextForProfile(
    [
      ...buildRegionTaskSection(imageVariants),
      ...buildWorkContextSection(regionOptions),
      `Contract sound-effect-translation-v${SOUND_EFFECT_TRANSLATION_CONTRACT_VERSION}.`,
      "This request has one fixed target only. Image 1 is its enlarged high-detail crop; Image 2 is the whole-page context with the target marked by translucent cyan fill and a magenta outline.",
      "Use the marker to locate the target in the scene. Read the original glyphs from Image 1, not the tinted context image. Ignore unrelated text in the crop margin and elsewhere on the page.",
      "Candidate identity and geometry are fixed. Never add, merge, split, move, or delete a candidate.",
      "Read all glyphs forming this target, including repeated and prolonged lettering. OCR is only a fallible reference; the visible source in Image 1 takes precedence over missing, incomplete or conflicting OCR.",
      "Use the scene, nearby dialogue, glossary and story memory to understand the meaning and tone. For sounds, preserve rhythm, repetition, duration and intensity in natural Korean comic lettering; for an expressive phrase, preserve its meaning rather than forcing it into an onomatopoeia. Do not mechanically transliterate kana or add an explanation of the scene.",
      `Visual-reading attempt=${attempt}.`,
      ...(attempt > 1 && retryFeedback
        ? [
            `- Validation failure: ${retryFeedback}`,
            "Read Image 1 again and correct that problem; do not simply repeat the rejected answer.",
          ]
        : []),
      "Return exactly one JSON object containing an items array with one item and only these keys:",
      "regionId, verdict, confirmedSource, translation, confidence",
      'verdict must be exactly "sound", "reaction", or "uncertain". Use uncertain only for an unreadable/non-text target or ordinary dialogue; OCR uncertainty alone is not sufficient.',
      "confirmedSource is the Japanese text read from Image 1. translation is one coherent, concise Korean translation; it must be empty for uncertain candidates. confidence is a number from 0 to 1.",
      "Do not return bbox, coordinates, explanations, or any regionId not listed here.",
      "Fixed target (bbox is a full-page locator only):",
      [
        `- regionId=${target.regionId}`,
        `bbox=${target.bbox.join(",")}`,
        `optionalHayaiOcrHint=${formatOcrHint(target.ocrHint)}`,
        `detectorConfidence=${target.detectorConfidence}`,
      ].join(" "),
    ].join("\n"),
    language,
  );
}

/** @param {Record<string, unknown>} options */
function readSoundEffectTarget(options) {
  const regions = Array.isArray(options.soundEffectTranslationRegions)
    ? options.soundEffectTranslationRegions
    : [];
  const item = isRecord(regions[0]) ? regions[0] : {};
  const bbox = isRecord(item.bbox) ? item.bbox : {};
  return {
    regionId: String(item.regionId ?? ""),
    bbox: [bbox.x, bbox.y, bbox.w, bbox.h].map(readFiniteNumber),
    ocrHint: String(item.recognizedText ?? "").trim(),
    detectorConfidence: readFiniteNumber(item.detectorConfidence),
  };
}

/** @param {unknown} value */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** @param {unknown} value */
function readFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/** @param {string} value */
function formatOcrHint(value) {
  if (!value) return "NONE (read the image yourself)";
  if (!containsJapanese(value)) {
    return `${JSON.stringify(value)} (IGNORE: no Japanese script; read Image 1 yourself)`;
  }
  return `${JSON.stringify(value)} (independent reading; reconcile with Image 1 and preserve supported repetition)`;
}

/** @param {string} value */
function containsJapanese(value) {
  return /[\u3040-\u30ff\u3400-\u9fff]/u.test(value);
}

/** @param {unknown} value */
function readRetryFeedback(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 600);
}

module.exports = {
  SOUND_EFFECT_TRANSLATION_CONTRACT_VERSION,
  buildSoundEffectTranslationPrompt,
  buildSoundEffectTranslationSystemPrompt,
};
