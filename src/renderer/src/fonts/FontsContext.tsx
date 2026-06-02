import React from "react";
import type { CustomFont } from "../../../shared/types";
import { getBlockFontOptions, setCustomFontOptions, type BlockFontOption } from "../lib/fonts";

const STYLE_ELEMENT_ID = "mgt-custom-fonts";

function injectCustomFontFaces(fonts: CustomFont[]): void {
  let style = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    document.head.appendChild(style);
  }
  style.textContent = fonts
    .map((font) => `@font-face { font-family: "${font.family}"; src: url("mgt-font://${font.id}"); font-display: swap; }`)
    .join("\n");
}

type FontsContextValue = {
  customFonts: CustomFont[];
  options: BlockFontOption[];
  busy: boolean;
  registerFont: () => Promise<void>;
  removeFont: (id: string) => Promise<void>;
};

const FontsContext = React.createContext<FontsContextValue | null>(null);

export function FontsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [customFonts, setFonts] = React.useState<CustomFont[]>([]);
  const [busy, setBusy] = React.useState(false);

  const apply = React.useCallback((fonts: CustomFont[]) => {
    setCustomFontOptions(fonts);
    injectCustomFontFaces(fonts);
    setFonts(fonts);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void window.mangaApi
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
      const added = await window.mangaApi.registerCustomFont();
      if (added) {
        const fonts = await window.mangaApi.listCustomFonts();
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
        const remaining = await window.mangaApi.removeCustomFont(id);
        apply(remaining);
      } catch (error) {
        console.error(error);
      } finally {
        setBusy(false);
      }
    },
    [apply]
  );

  const value = React.useMemo<FontsContextValue>(
    () => ({ customFonts, options: getBlockFontOptions(), busy, registerFont, removeFont }),
    [customFonts, busy, registerFont, removeFont]
  );

  return <FontsContext.Provider value={value}>{children}</FontsContext.Provider>;
}

export function useFonts(): FontsContextValue {
  const context = React.useContext(FontsContext);
  if (!context) {
    throw new Error("useFonts must be used within a FontsProvider");
  }
  return context;
}
