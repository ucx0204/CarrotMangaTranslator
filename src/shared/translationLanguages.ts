/**
 * Translation language domain shared by main/renderer.
 *
 * The language pair (source -> target) is translation-domain context and must
 * stay independent from the model provider (Gemma / Codex / API). PaddleOCR
 * specific `lang` strings are intentionally NOT defined here; only the OCR
 * adapter (paddleocr-vl-bboxes.py) maps language codes to Paddle models.
 */

export type LanguageCode = string;

export type TranslationLanguageSettings = {
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
};

export type ResolvedLanguage = {
  code: LanguageCode;
  /** 설정 UI에 보여줄 한국어 표시명. */
  labelKo: string;
  /** 모델 프롬프트에 사용할 영어 언어명. */
  promptName: string;
};

export type ResolvedLanguagePair = {
  source: ResolvedLanguage;
  target: ResolvedLanguage;
  /** 기존 기본 동작(일본어 만화 -> 한국어)인지 여부. 특화 프롬프트/OCR 최적화 게이트. */
  isDefaultJapaneseToKorean: boolean;
};

export const DEFAULT_SOURCE_LANGUAGE: LanguageCode = "ja";
export const DEFAULT_TARGET_LANGUAGE: LanguageCode = "ko";
export const MAX_LANGUAGE_CODE_LENGTH = 40;

export const DEFAULT_TRANSLATION_LANGUAGE_SETTINGS: TranslationLanguageSettings =
  {
    sourceLanguage: DEFAULT_SOURCE_LANGUAGE,
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
  };

/**
 * 설정 UI에 프리셋으로 노출되는 언어 목록.
 * promptName은 런타임 프롬프트 언어명 맵
 * (src/main/runtime/simple-page-language-profile.cjs)과 동기화되어야 하며,
 * tests/translationLanguages.test.ts가 이를 검증한다.
 */
export const KNOWN_TRANSLATION_LANGUAGES = [
  { code: "ja", labelKo: "일본어", promptName: "Japanese" },
  { code: "ko", labelKo: "한국어", promptName: "Korean" },
  { code: "en", labelKo: "영어", promptName: "English" },
  { code: "zh-Hans", labelKo: "중국어 간체", promptName: "Simplified Chinese" },
  {
    code: "zh-Hant",
    labelKo: "중국어 번체",
    promptName: "Traditional Chinese",
  },
  { code: "el", labelKo: "그리스어", promptName: "Greek" },
  { code: "nl", labelKo: "네덜란드어", promptName: "Dutch" },
  { code: "no", labelKo: "노르웨이어", promptName: "Norwegian" },
  { code: "da", labelKo: "덴마크어", promptName: "Danish" },
  { code: "de", labelKo: "독일어", promptName: "German" },
  { code: "lo", labelKo: "라오어", promptName: "Lao" },
  { code: "ru", labelKo: "러시아어", promptName: "Russian" },
  { code: "ro", labelKo: "루마니아어", promptName: "Romanian" },
  { code: "ms", labelKo: "말레이어", promptName: "Malay" },
  { code: "mn", labelKo: "몽골어", promptName: "Mongolian" },
  { code: "my", labelKo: "미얀마어", promptName: "Burmese" },
  { code: "vi", labelKo: "베트남어", promptName: "Vietnamese" },
  { code: "bn", labelKo: "벵골어", promptName: "Bengali" },
  { code: "bg", labelKo: "불가리아어", promptName: "Bulgarian" },
  { code: "sr", labelKo: "세르비아어", promptName: "Serbian" },
  { code: "sw", labelKo: "스와힐리어", promptName: "Swahili" },
  { code: "sv", labelKo: "스웨덴어", promptName: "Swedish" },
  { code: "es", labelKo: "스페인어", promptName: "Spanish" },
  { code: "sk", labelKo: "슬로바키아어", promptName: "Slovak" },
  { code: "ar", labelKo: "아랍어", promptName: "Arabic" },
  { code: "uk", labelKo: "우크라이나어", promptName: "Ukrainian" },
  { code: "ur", labelKo: "우르두어", promptName: "Urdu" },
  { code: "it", labelKo: "이탈리아어", promptName: "Italian" },
  { code: "id", labelKo: "인도네시아어", promptName: "Indonesian" },
  { code: "ka", labelKo: "조지아어", promptName: "Georgian" },
  { code: "cs", labelKo: "체코어", promptName: "Czech" },
  { code: "ca", labelKo: "카탈루냐어", promptName: "Catalan" },
  { code: "km", labelKo: "크메르어", promptName: "Khmer" },
  { code: "hr", labelKo: "크로아티아어", promptName: "Croatian" },
  { code: "ta", labelKo: "타밀어", promptName: "Tamil" },
  { code: "th", labelKo: "태국어", promptName: "Thai" },
  { code: "te", labelKo: "텔루구어", promptName: "Telugu" },
  { code: "tr", labelKo: "튀르키예어", promptName: "Turkish" },
  { code: "fa", labelKo: "페르시아어", promptName: "Persian" },
  { code: "pt", labelKo: "포르투갈어", promptName: "Portuguese" },
  {
    code: "pt-BR",
    labelKo: "포르투갈어(브라질)",
    promptName: "Brazilian Portuguese",
  },
  { code: "pl", labelKo: "폴란드어", promptName: "Polish" },
  { code: "fr", labelKo: "프랑스어", promptName: "French" },
  { code: "fil", labelKo: "필리핀어", promptName: "Filipino" },
  { code: "fi", labelKo: "핀란드어", promptName: "Finnish" },
  { code: "hu", labelKo: "헝가리어", promptName: "Hungarian" },
  { code: "he", labelKo: "히브리어", promptName: "Hebrew" },
  { code: "hi", labelKo: "힌디어", promptName: "Hindi" },
] as const satisfies readonly ResolvedLanguage[];

export type KnownLanguageCode =
  (typeof KNOWN_TRANSLATION_LANGUAGES)[number]["code"];

/** 설정 UI 상단 "주요 언어" 그룹에 노출되는 코드 순서. */
export const PRIMARY_TRANSLATION_LANGUAGE_CODES: LanguageCode[] = [
  "ja",
  "ko",
  "en",
  "zh-Hans",
  "zh-Hant",
];

/** 프리셋 외 별칭 코드도 프롬프트에서 읽을 수 있게 이름만 보강하는 맵. */
const EXTRA_LANGUAGE_NAMES: Record<string, ResolvedLanguage> = {
  zh: { code: "zh", labelKo: "중국어", promptName: "Simplified Chinese" },
};

const LANGUAGE_CODE_ALIASES: Record<string, KnownLanguageCode> = {
  "zh-CN": "zh-Hans",
  "zh-SG": "zh-Hans",
  "zh-TW": "zh-Hant",
  "zh-HK": "zh-Hant",
  "zh-MO": "zh-Hant",
};

const RTL_LANGUAGE_BASE_CODES = new Set(["ar", "fa", "he", "ur"]);

const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(-[a-zA-Z0-9]{1,16})*$/;

/** 직접 입력한 언어 코드가 저장 가능한 형태인지(en, zh-Hans, pt-BR 등). */
export function isValidLanguageCodeInput(value: unknown): boolean {
  const text = String(value ?? "").trim();
  return (
    Boolean(text) &&
    text.length <= MAX_LANGUAGE_CODE_LENGTH &&
    LANGUAGE_CODE_PATTERN.test(canonicalizeLanguageCodeCase(text))
  );
}

export function normalizeLanguageCode(
  value: unknown,
  fallback: LanguageCode,
): LanguageCode {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }
  const canonical = canonicalizeLanguageCodeCase(text);
  return canonical.length <= MAX_LANGUAGE_CODE_LENGTH &&
    LANGUAGE_CODE_PATTERN.test(canonical)
    ? canonical
    : fallback;
}

/** "ZH-HANS" -> "zh-Hans"처럼 BCP-47 관례에 맞춰 대소문자만 정규화한다. */
function canonicalizeLanguageCodeCase(value: string): string {
  const subtags = value.split("-");
  return subtags
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
}

export function resolveTranslationLanguageSettings(
  raw: unknown,
  defaults: TranslationLanguageSettings = DEFAULT_TRANSLATION_LANGUAGE_SETTINGS,
): TranslationLanguageSettings {
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    sourceLanguage: normalizeLanguageCode(
      record.sourceLanguage,
      defaults.sourceLanguage,
    ),
    targetLanguage: normalizeLanguageCode(
      record.targetLanguage,
      defaults.targetLanguage,
    ),
  };
}

/** 지역/스크립트 변형을 제외한 최상위 언어 코드(en-US -> en). */
export function getBaseLanguageCode(code: unknown): string {
  return normalizeLanguageCode(code, DEFAULT_SOURCE_LANGUAGE)
    .split("-", 1)[0]
    .toLowerCase();
}

export function isJapaneseLanguageCode(code: unknown): boolean {
  return getBaseLanguageCode(code) === "ja";
}

export function isKoreanLanguageCode(code: unknown): boolean {
  return getBaseLanguageCode(code) === "ko";
}

export function isRtlLanguageCode(code: unknown): boolean {
  return RTL_LANGUAGE_BASE_CODES.has(getBaseLanguageCode(code));
}

export function resolveSourceReadingDirection(code: unknown): "ltr" | "rtl" {
  return isJapaneseLanguageCode(code) || isRtlLanguageCode(code)
    ? "rtl"
    : "ltr";
}

export function resolveLanguage(code: LanguageCode): ResolvedLanguage {
  const normalized = normalizeLanguageCode(code, DEFAULT_SOURCE_LANGUAGE);
  const aliasedCode = resolveKnownLanguageAlias(normalized);
  const baseCode = getBaseLanguageCode(normalized);
  const known = KNOWN_TRANSLATION_LANGUAGES.find((language) => {
    if (language.code === normalized || language.code === aliasedCode) {
      return true;
    }
    // 정확한 지역 프리셋(pt-BR 등)이 없을 때만 기본 언어 프리셋을 쓴다.
    return !aliasedCode && language.code === baseCode;
  });
  if (known) {
    return { ...known, code: normalized };
  }
  const extra =
    EXTRA_LANGUAGE_NAMES[normalized] ?? EXTRA_LANGUAGE_NAMES[baseCode];
  if (extra) {
    return { ...extra, code: normalized };
  }
  return {
    code: normalized,
    labelKo: normalized,
    promptName: normalized.toUpperCase(),
  };
}

function resolveKnownLanguageAlias(
  normalized: string,
): KnownLanguageCode | undefined {
  const direct = LANGUAGE_CODE_ALIASES[normalized];
  if (direct) {
    return direct;
  }
  const subtags = normalized.split("-");
  if (subtags[0] !== "zh") {
    return undefined;
  }
  return subtags.includes("Hant") ||
    subtags.some((subtag) => ["TW", "HK", "MO"].includes(subtag))
    ? "zh-Hant"
    : "zh-Hans";
}

export function resolveLanguagePair(
  settings:
    | Partial<TranslationLanguageSettings>
    | { sourceLanguage?: unknown; targetLanguage?: unknown }
    | null
    | undefined,
): ResolvedLanguagePair {
  const sourceCode = normalizeLanguageCode(
    settings?.sourceLanguage,
    DEFAULT_SOURCE_LANGUAGE,
  );
  const targetCode = normalizeLanguageCode(
    settings?.targetLanguage,
    DEFAULT_TARGET_LANGUAGE,
  );
  return {
    source: resolveLanguage(sourceCode),
    target: resolveLanguage(targetCode),
    isDefaultJapaneseToKorean:
      isJapaneseLanguageCode(sourceCode) && isKoreanLanguageCode(targetCode),
  };
}
