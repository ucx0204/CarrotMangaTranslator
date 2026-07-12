import type { UiLocale } from "../uiLocales";
import ko from "./locales/ko";
import ja from "./locales/ja";
import en from "./locales/en";
import zhHans from "./locales/zh-Hans";
import zhHant from "./locales/zh-Hant";

export const APP_I18N_RESOURCES: Record<UiLocale, typeof ko> = {
  ko,
  ja,
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
};
