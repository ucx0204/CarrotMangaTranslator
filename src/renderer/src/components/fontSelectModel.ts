import React from "react";
import { useTranslation } from "react-i18next";
import { useFonts } from "../fonts/useFonts";
import { normalizeBlockFontFamily, resolveBlockFontOption } from "../lib/fonts";
import { toast } from "../lib/toastStore";

export type FontSelectProps = {
  value: string | undefined;
  ariaLabel?: string;
  disabled?: boolean;
  mixed?: boolean;
  onOpenManager?: () => void;
  onChange: (fontFamily: string | undefined) => void;
};

type FontLibrary = ReturnType<typeof useFonts>;
export type FontOption = FontLibrary["options"][number];

export type FontSelectModel = {
  busy: boolean;
  favoriteIds: ReadonlySet<string>;
  options: readonly FontOption[];
  selected: FontOption;
  onCommit: (id: string) => void;
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
  const { baseOptions, catalog, options, savePreferences, busy } = useFonts();
  const { preferences } = catalog;
  const favoriteIds = React.useMemo(
    () => new Set(preferences.favoriteIds),
    [preferences.favoriteIds],
  );
  const selected = resolveBlockFontOption(value, baseOptions);
  const pickerOptions = React.useMemo(
    () =>
      options.some((option) => option.id === selected.id)
        ? options
        : [selected, ...options],
    [options, selected],
  );

  const onCommit = React.useCallback(
    (id: string) => onChange(normalizeBlockFontFamily(id, catalog)),
    [catalog, onChange],
  );
  const onToggleFavorite = useFavoriteToggle(preferences, savePreferences);

  return {
    busy,
    favoriteIds,
    onCommit,
    onToggleFavorite,
    options: pickerOptions,
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
        hiddenIds: [...preferences.hiddenIds],
        defaultFontId: preferences.defaultFontId,
      }).catch((error) => {
        console.error(error);
        toast.error(t("fontManager.saveFailed"));
      });
    },
    [preferences, savePreferences, t],
  );
}
