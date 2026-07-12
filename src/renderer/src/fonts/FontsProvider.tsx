import React from "react";
import { useTranslation } from "react-i18next";
import type { CustomFont } from "../../../shared/libraryTypes";
import { normalizeUiLocale } from "../../../shared/uiLocales";
import { mangaGateway } from "../api/mangaGateway";
import { getBlockFontOptions, setCustomFontOptions } from "../lib/fonts";
import { FontsContext, type FontsContextValue } from "./fontsContextValue";

const STYLE_ELEMENT_ID = "mgt-custom-fonts";

function injectCustomFontFaces(fonts: CustomFont[]): void {
  let style = document.getElementById(
    STYLE_ELEMENT_ID,
  ) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  style.textContent = fonts
    .map(
      (font) =>
        `@font-face { font-family: "${font.family}"; src: url("mgt-font://${font.id}"); font-display: swap; }`,
    )
    .join("\n");
}

export function FontsProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const { i18n, t } = useTranslation("renderer");
  const uiLocale = normalizeUiLocale(i18n.resolvedLanguage ?? i18n.language);
  const [customFonts, setFonts] = React.useState<CustomFont[]>([]);
  const [busy, setBusy] = React.useState(false);

  const apply = React.useCallback((fonts: CustomFont[]) => {
    setCustomFontOptions(fonts);
    injectCustomFontFaces(fonts);
    setFonts(fonts);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void mangaGateway
      .listCustomFonts()
      .then((fonts) => {
        if (!cancelled) {
          apply(fonts);
        }
      })
      .catch((error) => console.error(error));
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const registerFont = React.useCallback(async () => {
    setBusy(true);
    try {
      const added = await mangaGateway.registerCustomFont();
      if (added) {
        const fonts = await mangaGateway.listCustomFonts();
        apply(fonts);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }, [apply]);

  const removeFont = React.useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const remaining = await mangaGateway.removeCustomFont(id);
        apply(remaining);
      } catch (error) {
        console.error(error);
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  const value = React.useMemo<FontsContextValue>(
    () => ({
      customFonts,
      options: getBlockFontOptions(t, uiLocale),
      busy,
      registerFont,
      removeFont,
    }),
    [customFonts, busy, registerFont, removeFont, t, uiLocale],
  );

  return (
    <FontsContext.Provider value={value}>{children}</FontsContext.Provider>
  );
}
