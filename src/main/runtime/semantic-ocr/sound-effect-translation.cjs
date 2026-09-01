// @ts-check

const {
  resolvePromptLanguageProfile,
} = require("../simple-page-language-profile.cjs");
const { buildWorkContextSection } = require("../prompts/work-context.cjs");

const SOUND_EFFECT_TRANSLATION_CONTRACT_VERSION = 2;

/** @param {Record<string, unknown>} options */
function buildSoundEffectTranslationSystemPrompt(options) {
  const language = resolvePromptLanguageProfile(options);
  const target = language.targetName;
  const workContext = buildWorkContextSection(options);
  const koreanGuidance = buildKoreanSoundEffectGuidance(
    language.targetBaseCode,
  );
  return [
    "You are a specialist Japanese manga SFX transcriber and localizer.",
    "Each request contains exactly one code-owned, immutable candidate shown in exactly two images.",
    "Image 1 is a downscaled whole-page context view. Its sole target is marked with translucent cyan fill and a magenta outline. Use it to infer the action, material, intensity, emotion, speaker, and nearby story context.",
    "Image 2 is an enlarged high-detail crop of that exact target. Read the source glyphs directly from Image 2; it is the transcription authority.",
    "Hayai OCR is only a fallible optional hint. Empty, low-confidence, garbled, or conflicting OCR must never make you skip a visibly readable target. Trust the target pixels over OCR.",
    "When the OCR hint contains plausible Japanese, use it as an independent second reading: if it disagrees with Image 2, inspect the glyphs again before deciding, especially repeated or prolonged kana. Do not silently drop repeated characters that are visible in separate positions.",
    "When the OCR hint is empty, punctuation-only, or contains no Japanese script, ignore it completely. Never echo punctuation as confirmedSource while Image 2 visibly contains stylized kana or kanji.",
    "Read all adjacent or spatially repeated glyph clusters in Image 2 that clearly form this one marked sound. Stylized strokes may overlap a character or prop; distinguish the lettering from the artwork instead of reducing it to punctuation.",
    "Candidate identity and geometry are immutable. Never add, merge, split, move, or delete a candidate, and never translate text outside the marked target.",
    `Localize only the target into ${target}.`,
    "For a pure sound, choose a short natural target-language onomatopoeia that matches the pictured event rather than mechanically transliterating Japanese. Preserve meaningful rhythm, repetition, duration, and intensity.",
    "Before writing JSON, silently do four checks in order: transcribe the visible glyphs; identify the depicted action, material, emotion, and acting subject from Image 1; choose the conventional comic lettering for that meaning in the target language; reject any phonetic-looking choice that describes a different event.",
    "For a printed reaction or short expressive phrase such as ブレないなぁ, preserve its concise semantic meaning instead of forcing it into a sound word.",
    "Use verdict uncertain only when the target crop truly contains no readable Japanese text (for example decoration, texture, or panel art), or is clearly ordinary dialogue. OCR uncertainty alone is never sufficient.",
    "Return one JSON object only, with an items array and no markdown or commentary.",
    ...(workContext.length > 0 ? ["", ...workContext] : []),
    ...(koreanGuidance.length > 0 ? ["", ...koreanGuidance] : []),
  ].join("\n");
}

/** @param {string} targetBaseCode */
function buildKoreanSoundEffectGuidance(targetBaseCode) {
  if (targetBaseCode !== "ko") return [];
  return [
    "MANDATORY FINAL KOREAN CHECK: use native, scene-correct Korean comic lettering, never convenient Japanese-syllable transcription when a conventional Korean expression exists.",
    "Canonical meaning contrasts: ガチャ at a latch is 철컥, while バタン at a slammed door or body is 쾅/탕 and must not be 철컥; がばっ when someone springs upright is 벌떡; ぷんぷん showing anger is 씩씩/부글부글, not a fart sound; ブン/ブンブン around human waving, shaking, or swinging is 붕붕/휘휘/절레절레 and must not be 부릉부릉 unless a vehicle or motor is visibly producing the sound; チチチ or チュンチュン from birds is 짹짹, not 치치치; ゴゴゴ as ominous pressure or rumbling is 쿠구구구/고오오; ワイ around cheering people is 와!/와아!, not a wind sound. Image 1 decides which listed meaning applies.",
    "Common action contrasts: つるっ during a slip is 미끌/쭉, not the surface adjective 매끈; イラッ is a flash of irritation such as 욱/짜증, not tearful emotion 울컥; くるっ is a quick turn such as 휙/빙글/홱, not a slow glide; キッ must follow Image 1—찌릿 for a sharp glare or 꽉/질끈 for tightening—and is not automatically the vocal grunt 큭; カァァ around visible blushing is 화끈/화악 rather than phonetic 화아아.",
    "Preserve visually distinct kana and repetition before localizing: for example ハハ is laughter while ハッ is a startled gasp, and two separately printed ブン clusters are repeated motion rather than one prolonged ブーン.",
  ];
}

/** @param {Record<string, unknown>} options */
function buildSoundEffectTranslationPrompt(options) {
  const language = resolvePromptLanguageProfile(options);
  const target = readSoundEffectTarget(options);
  const attempt = Number(options.translationAttempt) || 1;
  const retryFeedback = readRetryFeedback(options.soundEffectRetryFeedback);
  return [
    `Contract sound-effect-translation-v${SOUND_EFFECT_TRANSLATION_CONTRACT_VERSION}.`,
    "This request has one target only. Image 1 is the marked page context; Image 2 is the enlarged target crop.",
    `Visual-reading attempt=${attempt}. ${attempt > 1 ? "The previous answer failed validation. Reconcile Image 2 with any plausible Japanese OCR hint from scratch; ignore a punctuation-only hint." : "Read Image 2 first, then reconcile it with any plausible Japanese OCR hint."}`,
    ...(attempt > 1 && retryFeedback
      ? [
          `The previous answer was rejected for this concrete reason: ${retryFeedback}`,
          "Correct that problem from the two images; do not merely paraphrase the rejected answer.",
        ]
      : []),
    "Return exactly one item with only these keys:",
    "regionId, verdict, confirmedSource, translation, confidence",
    'verdict must be exactly "sound", "reaction", or "uncertain".',
    "confirmedSource is the Japanese text you personally read from Image 2. It may disagree with or replace the OCR hint.",
    "translation is short target-language text. For uncertain/non-text candidates it must be an empty string.",
    "confidence is a number from 0 to 1.",
    "Do not return bbox, coordinates, ordinary dialogue, explanations, or any regionId not listed here.",
    "Fixed target:",
    [
      `regionId=${target.regionId}`,
      `bbox=${target.bbox.join(",")}`,
      `optionalHayaiOcrHint=${formatOcrHint(target.ocrHint)}`,
      `detectorConfidence=${target.detectorConfidence}`,
    ].join(" "),
    ...(language.targetBaseCode === "ko"
      ? [
          "Final Korean gate: preserve the exact visible source reading, then choose Korean lettering for the pictured event—not Japanese phonetic transcription. Re-check the mandatory Korean contrasts in the system instruction before answering.",
        ]
      : []),
    "Output shape:",
    '{"items":[{"regionId":"...","verdict":"sound","confirmedSource":"...","translation":"...","confidence":0.9}]}',
  ].join("\n");
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
    return `${JSON.stringify(value)} (IGNORE: no Japanese script; read Image 2 yourself)`;
  }
  return `${JSON.stringify(value)} (independent reading; reconcile with Image 2 and preserve supported repetition)`;
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
