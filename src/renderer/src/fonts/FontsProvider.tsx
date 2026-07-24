import React from "react";
import { useTranslation } from "react-i18next";
import type {
  CustomFont,
  FontLibrarySnapshot,
  FontPreferences,
} from "../../../shared/libraryTypes";
import { normalizeUiLocale } from "../../../shared/uiLocales";
import { fontGateway as mangaGateway } from "../api/fontGateway";
import {
  createBlockFontCatalog,
  DEFAULT_BLOCK_FONT_CATALOG,
  getBaseBlockFontOptions,
  getBlockFontOptions,
  type BlockFontCatalog,
} from "../lib/fonts";
import { FontsContext, type FontsContextValue } from "./fontsContextValue";

export type FontLibrarySource = Pick<
  typeof mangaGateway,
  | "getFontLibrary"
  | "onFontLibraryChanged"
  | "registerCustomFont"
  | "removeCustomFont"
  | "saveFontPreferences"
>;

export function FontsProvider({
  children,
  source = mangaGateway,
}: {
  children: React.ReactNode;
  source?: FontLibrarySource;
}): React.JSX.Element {
  const { i18n, t } = useTranslation("renderer");
  const uiLocale = normalizeUiLocale(i18n.resolvedLanguage ?? i18n.language);
  const library = useFontLibraryState(source);
  const actions = useFontLibraryActions(library, source);
  useCustomFontFaces(library.catalog.customFonts);
  const value = React.useMemo<FontsContextValue>(
    () => ({
      catalog: library.catalog,
      baseOptions: getBaseBlockFontOptions(library.catalog, t, uiLocale),
      options: getBlockFontOptions(library.catalog, t, uiLocale),
      ...actions,
    }),
    [actions, library.catalog, t, uiLocale],
  );

  return (
    <FontsContext.Provider value={value}>{children}</FontsContext.Provider>
  );
}

type FontLibraryState = {
  catalog: BlockFontCatalog;
  apply: (snapshot: FontLibrarySnapshot) => void;
  refresh: () => Promise<void>;
};

function useFontLibraryState(source: FontLibrarySource): FontLibraryState {
  const [catalog, setCatalog] = React.useState<BlockFontCatalog>(
    DEFAULT_BLOCK_FONT_CATALOG,
  );
  const apply = React.useCallback((snapshot: FontLibrarySnapshot) => {
    setCatalog(
      createBlockFontCatalog(snapshot.customFonts, snapshot.preferences),
    );
  }, []);
  const refresh = React.useCallback(async (): Promise<void> => {
    apply(await source.getFontLibrary());
  }, [apply, source]);
  useFontLibrarySubscription(source, apply);
  return { apply, catalog, refresh };
}

function useFontLibrarySubscription(
  source: FontLibrarySource,
  apply: (snapshot: FontLibrarySnapshot) => void,
): void {
  React.useEffect(() => {
    let cancelled = false;
    void source
      .getFontLibrary()
      .then((snapshot) => {
        if (!cancelled) {
          apply(snapshot);
        }
      })
      .catch((error) => console.error(error));
    const unsubscribe = source.onFontLibraryChanged((snapshot) => {
      if (!cancelled) {
        apply(snapshot);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apply, source]);
}

function useFontLibraryActions(
  { apply, refresh }: FontLibraryState,
  source: FontLibrarySource,
): Pick<
  FontsContextValue,
  "busy" | "registerFont" | "removeFont" | "savePreferences"
> {
  const [busy, setBusy] = React.useState(false);
  const registerFont = React.useCallback(async () => {
    setBusy(true);
    try {
      const added = await source.registerCustomFont();
      if (added) {
        await refresh();
      }
    } catch (error) {
      console.error(error);
    } finally {
      setBusy(false);
    }
  }, [refresh, source]);

  const removeFont = React.useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        await source.removeCustomFont(id);
        await refresh();
      } catch (error) {
        console.error(error);
      } finally {
        setBusy(false);
      }
    },
    [refresh, source],
  );

  const savePreferences = React.useCallback(
    async (nextPreferences: FontPreferences) => {
      setBusy(true);
      try {
        apply(await source.saveFontPreferences(nextPreferences));
      } finally {
        setBusy(false);
      }
    },
    [apply, source],
  );
  return React.useMemo(
    () => ({ busy, registerFont, removeFont, savePreferences }),
    [busy, registerFont, removeFont, savePreferences],
  );
}

function useCustomFontFaces(fonts: readonly Readonly<CustomFont>[]): void {
  const styleRef = React.useRef<HTMLStyleElement | null>(null);
  React.useEffect(() => {
    const style = document.createElement("style");
    style.dataset.mgtCustomFonts = "";
    document.head.appendChild(style);
    styleRef.current = style;
    return () => {
      style.remove();
      styleRef.current = null;
    };
  }, []);
  React.useEffect(() => {
    if (!styleRef.current) {
      return;
    }
    styleRef.current.textContent = fonts
      .map(
        (font) =>
          `@font-face { font-family: "${font.family}"; src: url("mgt-font://${font.id}"); font-display: swap; }`,
      )
      .join("\n");
  }, [fonts]);
}
