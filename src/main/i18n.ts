import i18next, { type TOptions } from "i18next";
import { readFile } from "node:fs/promises";
import { APP_I18N_RESOURCES } from "../shared/i18n/resources";
import {
  DEFAULT_UI_LOCALE,
  normalizeUiLocale,
  SUPPORTED_UI_LOCALES,
  type UiLocale,
} from "../shared/uiLocales";

const mainI18n = i18next.createInstance();

void mainI18n.init({
  resources: Object.fromEntries(
    SUPPORTED_UI_LOCALES.map((locale) => [
      locale,
      {
        common: APP_I18N_RESOURCES[locale].common,
        main: APP_I18N_RESOURCES[locale].main,
      },
    ]),
  ),
  lng: DEFAULT_UI_LOCALE,
  fallbackLng: DEFAULT_UI_LOCALE,
  supportedLngs: [...SUPPORTED_UI_LOCALES],
  defaultNS: "main",
  ns: ["common", "main"],
  interpolation: { escapeValue: false },
  initAsync: false,
  returnNull: false,
});

export function setMainLocale(value: unknown): UiLocale {
  const locale = normalizeUiLocale(value, DEFAULT_UI_LOCALE);
  void mainI18n.changeLanguage(locale);
  return locale;
}

export async function initializeMainLocaleFromSettings(
  settingsPath: string,
  systemLocale: unknown,
): Promise<UiLocale> {
  const fallback = normalizeUiLocale(systemLocale, DEFAULT_UI_LOCALE);
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    const storedLocale =
      raw &&
      typeof raw === "object" &&
      "ui" in raw &&
      raw.ui &&
      typeof raw.ui === "object" &&
      "locale" in raw.ui
        ? raw.ui.locale
        : undefined;
    return setMainLocale(normalizeUiLocale(storedLocale, fallback));
  } catch (_error) {
    return setMainLocale(fallback);
  }
}

export function getMainLocale(): UiLocale {
  return normalizeUiLocale(mainI18n.language, DEFAULT_UI_LOCALE);
}

export function tMain(
  key: string,
  options?: TOptions & Record<string, unknown>,
): string {
  return mainI18n.t(key, { ns: "main", ...options });
}

export function tMainCommon(
  key: string,
  options?: TOptions & Record<string, unknown>,
): string {
  return mainI18n.t(key, { ns: "common", ...options });
}
