import React from "react";
import { useTranslation } from "react-i18next";
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import type { FontPreferences } from "../../../shared/libraryTypes";
import {
  DEFAULT_BLOCK_FONT_ID,
  DEFAULT_BLOCK_FONT_STACK,
} from "../../../shared/blockFontCatalog";
import { useFonts } from "../fonts/useFonts";
import { moveItemById, useStandardDndSensors } from "../lib/dnd";
import { orderBlockFontOptions, type BlockFontOption } from "../lib/fonts";
import { toast } from "../lib/toastStore";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { FontManagerGroup } from "./FontManagerList";
import styles from "./FontManagerModal.module.css";

export function FontManagerModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useFontManagerModel(onClose);

  return (
    <Modal
      title={t("fontManager.title")}
      onClose={model.disabled ? undefined : onClose}
      closeOnBackdrop
      size="lg"
      bodyClassName={styles.body}
      footer={<FontManagerFooter model={model} onClose={onClose} />}
    >
      <FontManagerControls model={model} />
      <DndContext
        sensors={model.sensors}
        collisionDetection={closestCenter}
        onDragEnd={model.handleDragEnd}
      >
        <FontManagerGroups model={model} />
      </DndContext>
    </Modal>
  );
}

type FontManagerModel = {
  disabled: boolean;
  dragDisabled: boolean;
  draft: FontPreferences;
  favoriteOptions: readonly BlockFontOption[];
  handleDragEnd: (event: DragEndEvent) => void;
  normalizedQuery: string;
  orderedOptions: readonly BlockFontOption[];
  otherOptions: readonly BlockFontOption[];
  query: string;
  registerFont: () => Promise<void>;
  resetOrder: () => void;
  save: () => Promise<void>;
  sensors: ReturnType<typeof useStandardDndSensors>;
  setDefault: (id: string) => void;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  toggleFavorite: (id: string) => void;
  visibleCount: number;
};

function useFontManagerModel(onClose: () => void): FontManagerModel {
  const { t } = useTranslation("components");
  const { baseOptions, busy, catalog, registerFont, savePreferences } =
    useFonts();
  const { preferences } = catalog;
  const [draft, setDraft] = React.useState<FontPreferences>(() => ({
    favoriteIds: [...preferences.favoriteIds],
    orderedIds: [...preferences.orderedIds],
    defaultFontId: preferences.defaultFontId,
  }));
  const [saving, setSaving] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const sensors = useStandardDndSensors();
  const orderedOptions = React.useMemo(
    () => buildManagerOptions(baseOptions, draft),
    [baseOptions, draft],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = filterFontOptions(orderedOptions, normalizedQuery);
  const favoriteIds = new Set(draft.favoriteIds);
  const favoriteOptions = visibleOptions.filter((option) =>
    favoriteIds.has(option.id),
  );
  const otherOptions = visibleOptions.filter(
    (option) => !favoriteIds.has(option.id),
  );
  const disabled = busy || saving;
  const dragDisabled = disabled || Boolean(normalizedQuery);
  const toggleFavorite = React.useCallback((id: string) => {
    setDraft((current) => toggleDraftFavorite(current, id));
  }, []);
  const handleDragEnd = useManagerDragEnd({
    dragDisabled,
    favoriteIds,
    favoriteOptions,
    otherOptions,
    setDraft,
  });
  const save = React.useCallback(async () => {
    setSaving(true);
    try {
      await savePreferences(draft);
      onClose();
    } catch (error) {
      console.error(error);
      toast.error(t("fontManager.saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [draft, onClose, savePreferences, t]);
  return {
    disabled,
    dragDisabled,
    draft,
    favoriteOptions,
    handleDragEnd,
    normalizedQuery,
    orderedOptions,
    otherOptions,
    query,
    registerFont,
    resetOrder: () => setDraft((current) => ({ ...current, orderedIds: [] })),
    save,
    sensors,
    setDefault: (id) =>
      setDraft((current) => ({ ...current, defaultFontId: id })),
    setQuery,
    toggleFavorite,
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

function useManagerDragEnd({
  dragDisabled,
  favoriteIds,
  favoriteOptions,
  otherOptions,
  setDraft,
}: {
  dragDisabled: boolean;
  favoriteIds: Set<string>;
  favoriteOptions: readonly BlockFontOption[];
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
        orderedIds: [...favorites, ...others].map((option) => option.id),
      }));
    },
    [dragDisabled, favoriteIds, favoriteOptions, otherOptions, setDraft],
  );
}

function FontManagerFooter({
  model,
  onClose,
}: {
  model: FontManagerModel;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      leading={
        <Button
          variant="ghost"
          className={styles.resetOrder}
          disabled={model.disabled}
          onClick={model.resetOrder}
        >
          {t("fontManager.resetOrder")}
        </Button>
      }
      actions={
        <>
          <Button
            variant="secondary"
            disabled={model.disabled}
            onClick={onClose}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={model.disabled}
            onClick={model.save}
          >
            {t("common.save")}
          </Button>
        </>
      }
    />
  );
}

function FontManagerControls({
  model,
}: {
  model: FontManagerModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.controls}>
      <label className={styles.defaultControl}>
        <span>{t("fontManager.defaultBadge")}</span>
        <select
          value={model.draft.defaultFontId}
          disabled={model.disabled}
          onChange={(event) => model.setDefault(event.target.value)}
        >
          {model.orderedOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <input
        className={styles.search}
        type="search"
        value={model.query}
        disabled={model.disabled}
        aria-label={t("fontManager.searchPlaceholder")}
        placeholder={t("fontManager.searchPlaceholder")}
        onChange={(event) => model.setQuery(event.target.value)}
      />
      <Button
        size="sm"
        disabled={model.disabled}
        onClick={() => void model.registerFont()}
      >
        {t("fontSelect.addFont")}
      </Button>
    </div>
  );
}

function FontManagerGroups({
  model,
}: {
  model: FontManagerModel;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  if (model.visibleCount === 0) {
    return <p className={styles.empty}>{t("fontManager.noSearchResults")}</p>;
  }
  return (
    <>
      {model.favoriteOptions.length || !model.normalizedQuery ? (
        <FontManagerGroup
          disabled={model.disabled}
          dragDisabled={model.dragDisabled}
          emptyLabel={t("fontManager.emptyFavorites")}
          favorite
          options={model.favoriteOptions}
          title={t("fontManager.favorites")}
          onToggleFavorite={model.toggleFavorite}
        />
      ) : null}
      {model.otherOptions.length ? (
        <FontManagerGroup
          disabled={model.disabled}
          dragDisabled={model.dragDisabled}
          favorite={false}
          options={model.otherOptions}
          title={t("fontManager.otherFonts")}
          onToggleFavorite={model.toggleFavorite}
        />
      ) : null}
    </>
  );
}
