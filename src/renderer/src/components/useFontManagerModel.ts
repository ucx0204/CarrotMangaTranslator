import React from "react";
import { useTranslation } from "react-i18next";
import type { DragEndEvent } from "@dnd-kit/core";
import type { FontPreferences } from "../../../shared/libraryTypes";
import {
  DEFAULT_BLOCK_FONT_ID,
  DEFAULT_BLOCK_FONT_STACK,
} from "../../../shared/blockFontCatalog";
import { useFonts } from "../fonts/useFonts";
import { moveItemById, useStandardDndSensors } from "../lib/dnd";
import { orderBlockFontOptions, type BlockFontOption } from "../lib/fonts";
import { toast } from "../lib/toastStore";

export type FontManagerModel = {
  customIds: ReadonlySet<string>;
  disabled: boolean;
  dragDisabled: boolean;
  draft: FontPreferences;
  favoriteOptions: readonly BlockFontOption[];
  hiddenOptions: readonly BlockFontOption[];
  handleDragEnd: (event: DragEndEvent) => void;
  normalizedQuery: string;
  orderedOptions: readonly BlockFontOption[];
  otherOptions: readonly BlockFontOption[];
  query: string;
  registerFont: () => Promise<void>;
  removeFont: (id: string) => Promise<void>;
  resetOrder: () => void;
  save: () => Promise<void>;
  sensors: ReturnType<typeof useStandardDndSensors>;
  setDefault: (id: string) => void;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  toggleFavorite: (id: string) => void;
  toggleHidden: (id: string) => void;
  visibleCount: number;
};

export function useFontManagerModel(onClose: () => void): FontManagerModel {
  const { t } = useTranslation("components");
  const fonts = useFonts();
  const [draft, setDraft] = React.useState<FontPreferences>(() =>
    clonePreferences(fonts.catalog.preferences),
  );
  const [saving, setSaving] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const sensors = useStandardDndSensors();
  const groups = React.useMemo(
    () => buildManagerGroups(fonts.baseOptions, fonts.catalog, draft, query),
    [draft, fonts.baseOptions, fonts.catalog, query],
  );
  const disabled = fonts.busy || saving;
  const dragDisabled = disabled || Boolean(groups.normalizedQuery);
  const toggleFavorite = React.useCallback((id: string) => {
    setDraft((current) => toggleDraftFavorite(current, id));
  }, []);
  const toggleHidden = React.useCallback((id: string) => {
    setDraft((current) => toggleDraftHidden(current, id));
  }, []);
  const handleDragEnd = useManagerDragEnd({
    dragDisabled,
    favoriteIds: groups.favoriteIds,
    favoriteOptions: groups.favoriteOptions,
    hiddenOptions: groups.hiddenOptions,
    otherOptions: groups.otherOptions,
    setDraft,
  });
  const save = useFontManagerSave({
    draft,
    onClose,
    savePreferences: fonts.savePreferences,
    setSaving,
    saveFailedMessage: t("fontManager.saveFailed"),
  });
  const resetOrder = React.useCallback(
    () => setDraft((current) => ({ ...current, orderedIds: [] })),
    [],
  );
  const setDefault = React.useCallback((id: string) => {
    setDraft((current) => ({
      ...current,
      defaultFontId: id,
      hiddenIds: current.hiddenIds.filter((hiddenId) => hiddenId !== id),
    }));
  }, []);
  return {
    ...groups,
    disabled,
    dragDisabled,
    draft,
    handleDragEnd,
    query,
    registerFont: fonts.registerFont,
    removeFont: fonts.removeFont,
    resetOrder,
    save,
    sensors,
    setDefault,
    setQuery,
    toggleFavorite,
    toggleHidden,
  };
}

function clonePreferences(
  preferences: ReturnType<typeof useFonts>["catalog"]["preferences"],
): FontPreferences {
  return {
    favoriteIds: [...preferences.favoriteIds],
    orderedIds: [...preferences.orderedIds],
    hiddenIds: [...preferences.hiddenIds],
    defaultFontId: preferences.defaultFontId,
  };
}

type FontManagerGroups = {
  customIds: ReadonlySet<string>;
  favoriteIds: ReadonlySet<string>;
  favoriteOptions: readonly BlockFontOption[];
  hiddenOptions: readonly BlockFontOption[];
  normalizedQuery: string;
  orderedOptions: readonly BlockFontOption[];
  otherOptions: readonly BlockFontOption[];
  visibleCount: number;
};

function buildManagerGroups(
  baseOptions: readonly BlockFontOption[],
  catalog: ReturnType<typeof useFonts>["catalog"],
  draft: FontPreferences,
  query: string,
): FontManagerGroups {
  const orderedOptions = buildManagerOptions(baseOptions, draft);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = filterFontOptions(orderedOptions, normalizedQuery);
  const favoriteIds = new Set(draft.favoriteIds);
  const hiddenIds = new Set(draft.hiddenIds);
  const hiddenOptions = visibleOptions.filter((option) =>
    hiddenIds.has(option.id),
  );
  const shownOptions = visibleOptions.filter(
    (option) => !hiddenIds.has(option.id),
  );
  return {
    customIds: new Set(catalog.customFonts.map((font) => font.id)),
    favoriteIds,
    favoriteOptions: shownOptions.filter((option) =>
      favoriteIds.has(option.id),
    ),
    hiddenOptions,
    normalizedQuery,
    orderedOptions,
    otherOptions: shownOptions.filter((option) => !favoriteIds.has(option.id)),
    visibleCount: visibleOptions.length,
  };
}

function buildManagerOptions(
  baseOptions: readonly BlockFontOption[],
  preferences: FontPreferences,
): readonly BlockFontOption[] {
  const designated = baseOptions.find(
    (option) => option.id === preferences.defaultFontId,
  );
  const options = baseOptions.map((option) =>
    option.id === DEFAULT_BLOCK_FONT_ID
      ? {
          ...option,
          cssFamily:
            preferences.defaultFontId === DEFAULT_BLOCK_FONT_ID
              ? DEFAULT_BLOCK_FONT_STACK
              : (designated?.cssFamily ?? DEFAULT_BLOCK_FONT_STACK),
        }
      : option,
  );
  return orderBlockFontOptions(options, preferences);
}

function filterFontOptions(
  options: readonly BlockFontOption[],
  query: string,
): readonly BlockFontOption[] {
  return query
    ? options.filter((option) =>
        `${option.label} ${option.sample}`.toLocaleLowerCase().includes(query),
      )
    : options;
}

function toggleDraftFavorite(
  preferences: FontPreferences,
  id: string,
): FontPreferences {
  const favorites = new Set(preferences.favoriteIds);
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  return { ...preferences, favoriteIds: [...favorites] };
}

function toggleDraftHidden(
  preferences: FontPreferences,
  id: string,
): FontPreferences {
  if (id === DEFAULT_BLOCK_FONT_ID || id === preferences.defaultFontId) {
    return preferences;
  }
  const hidden = new Set(preferences.hiddenIds);
  const favorites = new Set(preferences.favoriteIds);
  if (hidden.has(id)) hidden.delete(id);
  else {
    hidden.add(id);
    favorites.delete(id);
  }
  return {
    ...preferences,
    favoriteIds: [...favorites],
    hiddenIds: [...hidden],
  };
}

function useFontManagerSave({
  draft,
  onClose,
  saveFailedMessage,
  savePreferences,
  setSaving,
}: {
  draft: FontPreferences;
  onClose: () => void;
  saveFailedMessage: string;
  savePreferences: ReturnType<typeof useFonts>["savePreferences"];
  setSaving: React.Dispatch<React.SetStateAction<boolean>>;
}): () => Promise<void> {
  return React.useCallback(async () => {
    setSaving(true);
    try {
      await savePreferences(draft);
      onClose();
    } catch (error) {
      console.error(error);
      toast.error(saveFailedMessage);
    } finally {
      setSaving(false);
    }
  }, [draft, onClose, saveFailedMessage, savePreferences, setSaving]);
}

function useManagerDragEnd({
  dragDisabled,
  favoriteIds,
  favoriteOptions,
  hiddenOptions,
  otherOptions,
  setDraft,
}: {
  dragDisabled: boolean;
  favoriteIds: ReadonlySet<string>;
  favoriteOptions: readonly BlockFontOption[];
  hiddenOptions: readonly BlockFontOption[];
  otherOptions: readonly BlockFontOption[];
  setDraft: React.Dispatch<React.SetStateAction<FontPreferences>>;
}): (event: DragEndEvent) => void {
  return React.useCallback(
    (event) => {
      if (!event.over || event.active.id === event.over.id || dragDisabled) {
        return;
      }
      const activeId = String(event.active.id);
      const overId = String(event.over.id);
      const activeIsFavorite = favoriteIds.has(activeId);
      if (activeIsFavorite !== favoriteIds.has(overId)) return;
      const source = activeIsFavorite ? favoriteOptions : otherOptions;
      const moved = moveItemById(
        [...source],
        activeId,
        overId,
        (option) => option.id,
      );
      const favorites = activeIsFavorite ? moved : favoriteOptions;
      const others = activeIsFavorite ? otherOptions : moved;
      setDraft((current) => ({
        ...current,
        orderedIds: [...favorites, ...others, ...hiddenOptions].map(
          (option) => option.id,
        ),
      }));
    },
    [
      dragDisabled,
      favoriteIds,
      favoriteOptions,
      hiddenOptions,
      otherOptions,
      setDraft,
    ],
  );
}
