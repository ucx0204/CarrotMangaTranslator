import React from "react";
import { useTranslation } from "react-i18next";
import type {
  CustomFont,
  FontLibrarySnapshot,
  FontPreferences,
} from "../../../shared/libraryTypes";
import { normalizeUiLocale } from "../../../shared/uiLocales";
import { mangaGateway } from "../api/mangaGateway";
import {
  DEFAULT_FONT_PREFERENCES,
  getBaseBlockFontOptions,
  getBlockFontOptions,
  setCustomFontOptions,
  setFontPreferences,
} from "../lib/fonts";
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
  const library = useFontLibraryState();
  const actions = useFontLibraryActions(library);
  const value = React.useMemo<FontsContextValue>(
    () => ({
      customFonts: library.customFonts,
      preferences: library.preferences,
      baseOptions: getBaseBlockFontOptions(t, uiLocale, library.preferences),
      options: getBlockFontOptions(t, uiLocale, library.preferences),
      ...actions,
    }),
    [actions, library.customFonts, library.preferences, t, uiLocale],
  );

  return (
    <FontsContext.Provider value={value}>{children}</FontsContext.Provider>
  );
}

type FontLibraryState = {
  customFonts: CustomFont[];
  preferences: FontPreferences;
  apply: (snapshot: FontLibrarySnapshot) => void;
  refresh: () => Promise<void>;
};

function useFontLibraryState(): FontLibraryState {
  const [customFonts, setFonts] = React.useState<CustomFont[]>([]);
  const [preferences, setPreferences] = React.useState<FontPreferences>({
    ...DEFAULT_FONT_PREFERENCES,
  });
  const apply = React.useCallback((snapshot: FontLibrarySnapshot) => {
    setCustomFontOptions(snapshot.customFonts);
    setFontPreferences(snapshot.preferences);
    injectCustomFontFaces(snapshot.customFonts);
    setFonts(snapshot.customFonts);
    setPreferences(snapshot.preferences);
  }, []);
  const refresh = React.useCallback(async (): Promise<void> => {
    apply(await loadFontLibrarySnapshot());
  }, [apply]);
  useFontLibrarySubscription(apply);
  return { apply, customFonts, preferences, refresh };
}

function useFontLibrarySubscription(
  apply: (snapshot: FontLibrarySnapshot) => void,
): void {
  React.useEffect(() => {
    let cancelled = false;
    void loadFontLibrarySnapshot()
      .then((snapshot) => {
        if (!cancelled) {
          apply(snapshot);
        }
      })
      .catch((error) => console.error(error));
    const unsubscribe =
      typeof mangaGateway.onFontLibraryChanged === "function"
        ? mangaGateway.onFontLibraryChanged((snapshot) => {
            if (!cancelled) {
              apply(snapshot);
            }
          })
        : undefined;
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [apply]);
}

function useFontLibraryActions({
  apply,
  customFonts,
  refresh,
}: FontLibraryState): Pick<
  FontsContextValue,
  "busy" | "registerFont" | "removeFont" | "savePreferences"
> {
  const [busy, setBusy] = React.useState(false);
  const registerFont = React.useCallback(async () => {
    setBusy(true);
    try {
      const added = await mangaGateway.registerCustomFont();
      if (added) {
        await refresh();
      }
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const removeFont = React.useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const remaining = await mangaGateway.removeCustomFont(id);
        if (typeof mangaGateway.getFontLibrary === "function") {
          await refresh();
        } else {
          apply({
            customFonts: remaining,
            preferences: DEFAULT_FONT_PREFERENCES,
          });
        }
      } catch (error) {
        console.error(error);
      } finally {
        setBusy(false);
      }
    },
    [apply, refresh],
  );

  const savePreferences = React.useCallback(
    async (nextPreferences: FontPreferences) => {
      setBusy(true);
      try {
        if (typeof mangaGateway.saveFontPreferences !== "function") {
          apply({ customFonts, preferences: nextPreferences });
          return;
        }
        apply(await mangaGateway.saveFontPreferences(nextPreferences));
      } finally {
        setBusy(false);
      }
    },
    [apply, customFonts],
  );
  return { busy, registerFont, removeFont, savePreferences };
}

async function loadFontLibrarySnapshot(): Promise<FontLibrarySnapshot> {
  if (typeof mangaGateway.getFontLibrary === "function") {
    return mangaGateway.getFontLibrary();
  }
  return {
    customFonts: await mangaGateway.listCustomFonts(),
    preferences: DEFAULT_FONT_PREFERENCES,
  };
}
