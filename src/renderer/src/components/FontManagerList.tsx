import React from "react";
import { useTranslation } from "react-i18next";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { IconEye, IconEyeOff, IconTrash } from "@tabler/icons-react";
import { DEFAULT_BLOCK_FONT_ID } from "../../../shared/blockFontCatalog";
import type { BlockFontOption } from "../lib/fonts";
import styles from "./FontManagerModal.module.css";

export function FontManagerGroup({
  disabled,
  customIds,
  defaultFontId,
  dragDisabled,
  emptyLabel,
  favorite,
  hidden = false,
  onRemove,
  onToggleHidden,
  onToggleFavorite,
  options,
  title,
}: {
  disabled: boolean;
  customIds: ReadonlySet<string>;
  defaultFontId: string;
  dragDisabled: boolean;
  emptyLabel?: string;
  favorite: boolean;
  hidden?: boolean;
  onRemove: (id: string) => Promise<void>;
  onToggleHidden: (id: string) => void;
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
                custom={customIds.has(option.id)}
                hideDisabled={
                  option.id === DEFAULT_BLOCK_FONT_ID ||
                  option.id === defaultFontId
                }
                dragDisabled={dragDisabled}
                favorite={favorite}
                favoriteDisabled={hidden}
                hidden={hidden}
                onRemove={() => void onRemove(option.id)}
                onToggleHidden={() => onToggleHidden(option.id)}
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

type FontRowProps = {
  disabled: boolean;
  custom: boolean;
  dragDisabled: boolean;
  favorite: boolean;
  favoriteDisabled: boolean;
  hidden: boolean;
  hideDisabled: boolean;
  onRemove: () => void;
  onToggleHidden: () => void;
  onToggleFavorite: () => void;
  option: BlockFontOption;
};

function SortableFontRow(props: FontRowProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: props.option.id,
    disabled: props.dragDisabled,
  });
  return (
    <div
      ref={setNodeRef}
      className={`${styles.row} ${isDragging ? styles.dragging : ""}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        className={styles.dragHandle}
        disabled={props.dragDisabled}
        aria-label={t("fontManager.moveNamedFont", {
          label: props.option.label,
        })}
        title={t("common.dragToMove")}
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">⠿</span>
      </button>
      <FontRowContent {...props} />
    </div>
  );
}

function FontRowContent({
  custom,
  disabled,
  favorite,
  favoriteDisabled,
  hidden,
  hideDisabled,
  onRemove,
  onToggleFavorite,
  onToggleHidden,
  option,
}: FontRowProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <button
        type="button"
        className={`${styles.star} ${favorite ? styles.starActive : ""}`}
        disabled={disabled || favoriteDisabled}
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
      <FontRowPreview option={option} />
      <button
        type="button"
        className={styles.rowAction}
        disabled={disabled || hideDisabled}
        aria-label={t(
          hidden ? "fontManager.showNamedFont" : "fontManager.hideNamedFont",
          { label: option.label },
        )}
        title={t(hidden ? "fontManager.showFont" : "fontManager.hideFont")}
        onClick={onToggleHidden}
      >
        {hidden ? (
          <IconEye size={16} aria-hidden="true" />
        ) : (
          <IconEyeOff size={16} aria-hidden="true" />
        )}
      </button>
      {custom ? (
        <button
          type="button"
          className={`${styles.rowAction} ${styles.deleteAction}`}
          disabled={disabled}
          aria-label={t("fontSelect.deleteNamedFont", { label: option.label })}
          title={t("fontSelect.deleteFont")}
          onClick={onRemove}
        >
          <IconTrash size={16} aria-hidden="true" />
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
    </>
  );
}

function FontRowPreview({
  option,
}: {
  option: BlockFontOption;
}): React.JSX.Element {
  return (
    <div className={styles.preview}>
      <span className={styles.label}>{option.label}</span>
      <span className={styles.sample} style={{ fontFamily: option.cssFamily }}>
        {option.sample}
      </span>
    </div>
  );
}
