// @ts-check
/**
 * Prompt-side language profile for the translation runtime.
 *
 * The runtime .cjs modules cannot import the shared TypeScript language
 * domain (src/shared/translationLanguages.ts), so the small prompt-name map
 * is kept here. The default Japanese -> Korean profile must preserve the
 * existing tuned prompt wording byte-for-byte; every other language pair uses
 * the generic multilingual localization in simple-page-prompts.cjs.
 *
 * @typedef {{
 *   sourceCode: string;
 *   targetCode: string;
 *   sourceBaseCode: string;
 *   targetBaseCode: string;
 *   sourceName: string;
 *   targetName: string;
 *   sourceIsRtl: boolean;
 *   sourceKey: "jp" | "source";
 *   targetKey: "ko" | "target";
 *   isDefaultJapaneseToKorean: boolean;
 * }} PromptLanguageProfile
 */

const DEFAULT_SOURCE_LANGUAGE = "ja";
const DEFAULT_TARGET_LANGUAGE = "ko";
const MAX_LANGUAGE_CODE_LENGTH = 40;
const RTL_LANGUAGE_BASE_CODES = new Set(["ar", "fa", "he", "ur"]);
/** @type {Record<string, string>} */
const LANGUAGE_CODE_ALIASES = {
  "zh-CN": "zh-Hans",
  "zh-SG": "zh-Hans",
  "zh-TW": "zh-Hant",
  "zh-HK": "zh-Hant",
  "zh-MO": "zh-Hant",
};

// src/shared/translationLanguages.ts의 KNOWN_TRANSLATION_LANGUAGES와 동기화.
// tests/translationLanguages.test.ts가 두 맵의 promptName 일치를 검증한다.
/** @type {Record<string, string>} */
const PROMPT_LANGUAGE_NAMES = {
  ja: "Japanese",
  ko: "Korean",
  en: "English",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  zh: "Simplified Chinese",
  ar: "Arabic",
  bg: "Bulgarian",
  bn: "Bengali",
  ca: "Catalan",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  es: "Spanish",
  fa: "Persian",
  fi: "Finnish",
  fil: "Filipino",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  hr: "Croatian",
  hu: "Hungarian",
  id: "Indonesian",
  it: "Italian",
  ka: "Georgian",
  km: "Khmer",
  lo: "Lao",
  mn: "Mongolian",
  ms: "Malay",
  my: "Burmese",
  nl: "Dutch",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  "pt-BR": "Brazilian Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sk: "Slovak",
  sr: "Serbian",
  sv: "Swedish",
  sw: "Swahili",
  ta: "Tamil",
  te: "Telugu",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  ur: "Urdu",
  vi: "Vietnamese",
};

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[a-zA-Z0-9]{1,16})*$/;

/**
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeLanguageCode(value, fallback) {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }
  const canonical = text
    .split("-")
    .map((subtag, index) => {
      if (index === 0) {
        return subtag.toLowerCase();
      }
      if (subtag.length === 4 && /^[a-zA-Z]+$/.test(subtag)) {
        return subtag.charAt(0).toUpperCase() + subtag.slice(1).toLowerCase();
      }
      if (subtag.length === 2 && /^[a-zA-Z]+$/.test(subtag)) {
        return subtag.toUpperCase();
      }
      return subtag.toLowerCase();
    })
    .join("-");
  return canonical.length <= MAX_LANGUAGE_CODE_LENGTH &&
    LANGUAGE_CODE_PATTERN.test(canonical)
    ? canonical
    : fallback;
}

/**
 * @param {string} code
 * @returns {string}
 */
function resolvePromptLanguageName(code) {
  const aliasedCode = resolveLanguageCodeAlias(code);
  const baseCode = getBaseLanguageCode(code);
  return (
    PROMPT_LANGUAGE_NAMES[code] ||
    (aliasedCode ? PROMPT_LANGUAGE_NAMES[aliasedCode] : undefined) ||
    PROMPT_LANGUAGE_NAMES[baseCode] ||
    code.toUpperCase()
  );
}

/** @param {string} code @returns {string | undefined} */
function resolveLanguageCodeAlias(code) {
  const direct = LANGUAGE_CODE_ALIASES[code];
  if (direct) {
    return direct;
  }
  const subtags = code.split("-");
  if (subtags[0] !== "zh") {
    return undefined;
  }
  return subtags.includes("Hant") ||
    subtags.some((subtag) => ["TW", "HK", "MO"].includes(subtag))
    ? "zh-Hant"
    : "zh-Hans";
}

/** @param {unknown} code @returns {string} */
function getBaseLanguageCode(code) {
  return normalizeLanguageCode(code, DEFAULT_SOURCE_LANGUAGE)
    .split("-", 1)[0]
    .toLowerCase();
}

/** @param {unknown} code @returns {boolean} */
function isJapaneseLanguageCode(code) {
  return getBaseLanguageCode(code) === "ja";
}

/** @param {unknown} code @returns {boolean} */
function isKoreanLanguageCode(code) {
  return getBaseLanguageCode(code) === "ko";
}

/**
 * @param {{ sourceLanguage?: unknown; targetLanguage?: unknown } | null | undefined} [options]
 * @returns {PromptLanguageProfile}
 */
function resolvePromptLanguageProfile(options = {}) {
  const sourceCode = normalizeLanguageCode(
    options?.sourceLanguage,
    DEFAULT_SOURCE_LANGUAGE,
  );
  const targetCode = normalizeLanguageCode(
    options?.targetLanguage,
    DEFAULT_TARGET_LANGUAGE,
  );
  const sourceBaseCode = getBaseLanguageCode(sourceCode);
  const targetBaseCode = getBaseLanguageCode(targetCode);
  const isDefaultJapaneseToKorean =
    isJapaneseLanguageCode(sourceCode) && isKoreanLanguageCode(targetCode);
  return {
    sourceCode,
    targetCode,
    sourceBaseCode,
    targetBaseCode,
    sourceName: resolvePromptLanguageName(sourceCode),
    targetName: resolvePromptLanguageName(targetCode),
    sourceIsRtl: RTL_LANGUAGE_BASE_CODES.has(sourceBaseCode),
    sourceKey: isDefaultJapaneseToKorean ? "jp" : "source",
    targetKey: isDefaultJapaneseToKorean ? "ko" : "target",
    isDefaultJapaneseToKorean,
  };
}

/**
 * @param {PromptLanguageProfile} profile
 * @returns {boolean}
 */
function isDefaultJapaneseToKoreanProfile(profile) {
  return Boolean(profile && profile.isDefaultJapaneseToKorean);
}

/**
 * @param {{ sourceLanguage?: unknown } | null | undefined} [options]
 * @returns {boolean}
 */
function isJapaneseSourceLanguage(options = {}) {
  return isJapaneseLanguageCode(options?.sourceLanguage);
}

/**
 * OCR가 "텍스트 없음"이라고 답했을 때 모델 호출을 생략해도 되는지.
 * 일본어 원문에서만 안전한 최적화다. 다른 언어는 OCR 언어 지원이 검증되기
 * 전까지 false negative가 더 위험하므로 항상 모델을 호출한다.
 *
 * @param {{ sourceLanguage?: unknown } | null | undefined} [options]
 * @returns {boolean}
 */
function allowOcrNoTextDetectedSkip(options = {}) {
  return isJapaneseSourceLanguage(options);
}

module.exports = {
  allowOcrNoTextDetectedSkip,
  getBaseLanguageCode,
  isDefaultJapaneseToKoreanProfile,
  isJapaneseLanguageCode,
  isJapaneseSourceLanguage,
  isKoreanLanguageCode,
  normalizeLanguageCode,
  resolvePromptLanguageName,
  resolvePromptLanguageProfile,
};
