import React from "react";
import { I18nextProvider } from "react-i18next";
import {
  getUiLocaleOption,
  normalizeUiLocale,
  type UiLocale,
} from "../../shared/uiLocales";
import { uiLocaleGateway } from "./api/uiLocaleGateway";
import { appI18n } from "./appI18n";
import { parsePanelRoute } from "./panels/panelRoute";

export function AppI18nProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <I18nextProvider i18n={appI18n}>
      <LocaleEffects />
      {children}
    </I18nextProvider>
  );
}

function LocaleEffects(): null {
  React.useEffect(() => {
    applyDocumentLocale(normalizeUiLocale(appI18n.language));
    const handleLanguageChanged = (nextLanguage: string) => {
      applyDocumentLocale(normalizeUiLocale(nextLanguage));
    };
    appI18n.on("languageChanged", handleLanguageChanged);
    const unsubscribe = uiLocaleGateway.onUiLocaleChanged((nextLocale) => {
      const normalizedLocale = normalizeUiLocale(nextLocale);
      if (normalizedLocale === normalizeUiLocale(appI18n.language)) {
        return;
      }
      void appI18n.changeLanguage(normalizedLocale);
    });
    return () => {
      appI18n.off("languageChanged", handleLanguageChanged);
      unsubscribe();
    };
  }, []);
  return null;
}

function applyDocumentLocale(locale: UiLocale): void {
  const option = getUiLocaleOption(locale);
  document.documentElement.lang = option.htmlLang;
  document.documentElement.dir = option.direction;
  document.documentElement.dataset.locale = locale;
  document.title = parsePanelRoute(window.location.hash)
    ? appI18n.t("panel.editorTitle", { ns: "common" })
    : appI18n.t("app.title", { ns: "common" });
}
