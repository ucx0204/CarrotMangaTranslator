export const SUPPORTED_UI_LOCALES = [
  "ko",
  "ja",
  "en",
  "zh-Hans",
  "zh-Hant",
] as const;

export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

export const DEFAULT_UI_LOCALE: UiLocale = "ko";

export type UiLocaleOption = {
  id: UiLocale;
  nativeName: string;
  htmlLang: string;
  direction: "ltr" | "rtl";
};

export const UI_LOCALE_OPTIONS: readonly UiLocaleOption[] = [
  { id: "ko", nativeName: "한국어", htmlLang: "ko", direction: "ltr" },
  { id: "ja", nativeName: "日本語", htmlLang: "ja", direction: "ltr" },
  { id: "en", nativeName: "English", htmlLang: "en", direction: "ltr" },
  {
    id: "zh-Hans",
    nativeName: "简体中文",
    htmlLang: "zh-Hans",
    direction: "ltr",
  },
  {
    id: "zh-Hant",
    nativeName: "繁體中文",
    htmlLang: "zh-Hant",
    direction: "ltr",
  },
] as const;

const UI_LOCALE_BY_LANGUAGE: Readonly<Record<string, UiLocale>> = {
  ko: "ko",
  ja: "ja",
  en: "en",
};

const TRADITIONAL_CHINESE_SUBTAGS = new Set(["hant", "tw", "hk", "mo"]);

function isUiLocale(value: unknown): value is UiLocale {
  return SUPPORTED_UI_LOCALES.includes(value as UiLocale);
}

/** Maps a saved locale or a Windows/BCP-47 locale to a supported UI locale. */
export function resolveUiLocale(value: unknown): UiLocale | null {
  if (isUiLocale(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const [language, ...subtags] = value
    .trim()
    .replaceAll("_", "-")
    .toLowerCase()
    .split("-");
  if (language === "zh") {
    return subtags.some((subtag) => TRADITIONAL_CHINESE_SUBTAGS.has(subtag))
      ? "zh-Hant"
      : "zh-Hans";
  }
  return UI_LOCALE_BY_LANGUAGE[language] ?? null;
}

export function normalizeUiLocale(
  value: unknown,
  fallback: UiLocale = DEFAULT_UI_LOCALE,
): UiLocale {
  return resolveUiLocale(value) ?? fallback;
}

export function getUiLocaleOption(locale: UiLocale): UiLocaleOption {
  return (
    UI_LOCALE_OPTIONS.find((option) => option.id === locale) ??
    UI_LOCALE_OPTIONS[0]
  );
}
