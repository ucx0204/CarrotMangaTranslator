import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { APP_I18N_RESOURCES } from "../../shared/i18n/resources";
import {
  DEFAULT_UI_LOCALE,
  SUPPORTED_UI_LOCALES,
  type UiLocale,
} from "../../shared/uiLocales";

export const appI18n = i18next.createInstance();

let initialization: Promise<void> | null = null;

export function initializeAppI18n(locale: UiLocale): Promise<void> {
  if (!initialization) {
    const resources = Object.fromEntries(
      SUPPORTED_UI_LOCALES.map((supportedLocale) => [
        supportedLocale,
        {
          common: APP_I18N_RESOURCES[supportedLocale].common,
          components: APP_I18N_RESOURCES[supportedLocale].components,
          renderer: APP_I18N_RESOURCES[supportedLocale].renderer,
        },
      ]),
    );
    initialization = appI18n
      .use(initReactI18next)
      .init({
        resources,
        lng: locale,
        fallbackLng: DEFAULT_UI_LOCALE,
        supportedLngs: [...SUPPORTED_UI_LOCALES],
        defaultNS: "common",
        ns: ["common", "components", "renderer"],
        interpolation: { escapeValue: false },
        returnNull: false,
      })
      .then(() => undefined);
  } else if (appI18n.language !== locale) {
    initialization = initialization.then(async () => {
      await appI18n.changeLanguage(locale);
    });
  }
  return initialization;
}
