import React from "react";
import { useTranslation } from "react-i18next";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { BlockFontOption } from "../lib/fonts";
import styles from "./FontManagerModal.module.css";

export function FontManagerGroup({
  disabled,
  dragDisabled,
  emptyLabel,
  favorite,
  onToggleFavorite,
  options,
  title,
}: {
  disabled: boolean;
  dragDisabled: boolean;
  emptyLabel?: string;
  favorite: boolean;
  onToggleFavorite: (id: string) => void;
  options: readonly BlockFontOption[];
  title: string;
}): React.JSX.Element {
  return (
    <section className={styles.group}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <SortableContext
        items={options.map((option) => option.id)}
        strategy={verticalListSortingStrategy}
      >
        <div className={styles.list}>
          {options.length ? (
            options.map((option) => (
              <SortableFontRow
                key={option.id}
                disabled={disabled}
                dragDisabled={dragDisabled}
                favorite={favorite}
                onToggleFavorite={() => onToggleFavorite(option.id)}
                option={option}
              />
            ))
          ) : (
            <p className={styles.empty}>{emptyLabel}</p>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableFontRow({
  disabled,
  dragDisabled,
  favorite,
  onToggleFavorite,
  option,
}: {
  disabled: boolean;
  dragDisabled: boolean;
  favorite: boolean;
  onToggleFavorite: () => void;
  option: BlockFontOption;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: option.id, disabled: dragDisabled });
  return (
    <div
      ref={setNodeRef}
      className={`${styles.row} ${isDragging ? styles.dragging : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className={styles.dragHandle}
        disabled={dragDisabled}
        aria-label={t("fontManager.moveNamedFont", { label: option.label })}
        title={t("common.dragToMove")}
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <button
        type="button"
        className={`${styles.star} ${favorite ? styles.starActive : ""}`}
        disabled={disabled}
        aria-pressed={favorite}
        aria-label={t(
          favorite
            ? "fontSelect.unfavoriteNamedFont"
            : "fontSelect.favoriteNamedFont",
          { label: option.label },
        )}
        onClick={onToggleFavorite}
      >
        <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
      </button>
      <div className={styles.preview}>
        <span className={styles.label}>{option.label}</span>
        <span
          className={styles.sample}
          style={{ fontFamily: option.cssFamily }}
        >
          {option.sample}
        </span>
      </div>
    </div>
  );
}
