import React from "react";
import { useTranslation } from "react-i18next";
import { useFonts } from "../fonts/useFonts";
import { normalizeBlockFontFamily, resolveBlockFontOption } from "../lib/fonts";
import { toast } from "../lib/toastStore";

export type FontSelectProps = {
  value: string | undefined;
  ariaLabel?: string;
  disabled?: boolean;
  onChange: (fontFamily: string | undefined) => void;
};

type FontLibrary = ReturnType<typeof useFonts>;
export type FontOption = FontLibrary["options"][number];

export type FontSelectModel = {
  busy: boolean;
  customIds: ReadonlySet<string>;
  favoriteIds: ReadonlySet<string>;
  options: readonly FontOption[];
  selected: FontOption;
  onAddFont: () => void;
  onCommit: (id: string) => void;
  onRemoveFont: (id: string) => void;
  onToggleFavorite: (id: string) => void;
};

/**
 * Font library state for the font picker. The popup lifecycle, keyboard model,
 * and positioning all come from `ui/Select`; this only owns font data and the
 * library mutations.
 */
export function useFontSelectModel({
  value,
  onChange,
}: FontSelectProps): FontSelectModel {
  const { catalog, options, registerFont, removeFont, savePreferences, busy } =
    useFonts();
  const { customFonts, preferences } = catalog;
  const customIds = React.useMemo(
    () => new Set(customFonts.map((font) => font.id)),
    [customFonts],
  );
  const favoriteIds = React.useMemo(
    () => new Set(preferences.favoriteIds),
    [preferences.favoriteIds],
  );
  const selected = resolveBlockFontOption(value, options);

  const onCommit = React.useCallback(
    (id: string) => onChange(normalizeBlockFontFamily(id, catalog)),
    [catalog, onChange],
  );
  const onAddFont = React.useCallback(() => {
    void registerFont();
  }, [registerFont]);
  const onRemoveFont = React.useCallback(
    (id: string) => {
      void removeFont(id);
    },
    [removeFont],
  );
  const onToggleFavorite = useFavoriteToggle(preferences, savePreferences);

  return {
    busy,
    customIds,
    favoriteIds,
    onAddFont,
    onCommit,
    onRemoveFont,
    onToggleFavorite,
    options,
    selected,
  };
}

function useFavoriteToggle(
  preferences: FontLibrary["catalog"]["preferences"],
  savePreferences: FontLibrary["savePreferences"],
): (id: string) => void {
  const { t } = useTranslation("components");
  return React.useCallback(
    (id: string) => {
      const favorites = new Set(preferences.favoriteIds);
      if (favorites.has(id)) {
        favorites.delete(id);
      } else {
        favorites.add(id);
      }
      void savePreferences({
        favoriteIds: [...favorites],
        orderedIds: [...preferences.orderedIds],
        defaultFontId: preferences.defaultFontId,
      }).catch((error) => {
        console.error(error);
        toast.error(t("fontManager.saveFailed"));
      });
    },
    [preferences, savePreferences, t],
  );
}
