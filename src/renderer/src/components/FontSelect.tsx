import React from "react";
import { useTranslation } from "react-i18next";
import { FontManagerModal } from "./FontManagerModal";
import styles from "./FontSelect.module.css";
import {
  resolveFontOptionClassName,
  useFontSelectModel,
  type FontOption,
  type FontSelectModel,
  type FontSelectProps,
} from "./fontSelectModel";

export function FontSelect(props: FontSelectProps): React.JSX.Element {
  const { listRef, model, rootRef } = useFontSelectModel(props);
  const [managerOpen, setManagerOpen] = React.useState(false);
  return (
    <>
      <FontSelectView
        listRef={listRef}
        model={model}
        onManage={() => {
          model.setOpen(false);
          setManagerOpen(true);
        }}
        rootRef={rootRef}
      />
      {managerOpen ? (
        <FontManagerModal onClose={() => setManagerOpen(false)} />
      ) : null}
    </>
  );
}

function FontSelectView({
  listRef,
  model,
  onManage,
  rootRef,
}: {
  listRef: React.RefObject<HTMLDivElement | null>;
  model: FontSelectModel;
  onManage: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  return (
    <div className={`font-select ${model.open ? "open" : ""}`} ref={rootRef}>
      <FontSelectTrigger model={model} />
      {model.open ? (
        <FontSelectMenu listRef={listRef} model={model} onManage={onManage} />
      ) : null}
    </div>
  );
}

function FontSelectTrigger({
  model,
}: {
  model: FontSelectModel;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="font-select-trigger"
      disabled={model.disabled}
      aria-haspopup="listbox"
      aria-expanded={model.open}
      onClick={() => model.setOpen((current) => !current)}
      onKeyDown={model.onTriggerKeyDown}
    >
      <span className="font-select-name">{model.selected.label}</span>
      <span
        className="font-select-sample"
        style={{ fontFamily: model.selected.cssFamily }}
      >
        {model.selected.sample}
      </span>
      <ChevronIcon />
    </button>
  );
}

function FontSelectMenu({
  listRef,
  model,
  onManage,
}: {
  listRef: React.RefObject<HTMLDivElement | null>;
  model: FontSelectModel;
  onManage: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="font-select-menu">
      <div
        className="font-select-options"
        role="listbox"
        tabIndex={-1}
        ref={listRef}
        onKeyDown={model.onListKeyDown}
      >
        {model.options.map((option, index) => (
          <FontSelectOption
            key={option.id}
            active={index === model.activeIndex}
            busy={model.busy}
            custom={model.customIds.has(option.id)}
            favorite={model.favoriteIds.has(option.id)}
            onCommit={model.onOptionCommit}
            onHover={() => model.onOptionHover(index)}
            onRemove={model.onRemoveFont}
            onToggleFavorite={model.onToggleFavorite}
            option={option}
            selected={option.id === model.selected.id}
          />
        ))}
      </div>
      <div className={styles.footer}>
        <button
          type="button"
          className="font-select-add"
          disabled={model.busy}
          onClick={model.onAddFont}
        >
          {t("fontSelect.addFont")}
        </button>
        <button
          type="button"
          className="font-select-add"
          disabled={model.busy}
          onClick={onManage}
        >
          {t("fontSelect.manageFonts")}
        </button>
      </div>
    </div>
  );
}

function FontSelectOption({
  active,
  busy,
  custom,
  favorite,
  onCommit,
  onHover,
  onRemove,
  onToggleFavorite,
  option,
  selected,
}: {
  active: boolean;
  busy: boolean;
  custom: boolean;
  favorite: boolean;
  onCommit: (id: string) => void;
  onHover: () => void;
  onRemove: (id: string) => void;
  onToggleFavorite: (id: string) => void;
  option: FontOption;
  selected: boolean;
}): React.JSX.Element {
  return (
    <div
      role="option"
      aria-selected={selected}
      className={resolveFontOptionClassName(selected, active)}
      onPointerEnter={onHover}
      onClick={() => onCommit(option.id)}
    >
      <span className="font-select-option-label">{option.label}</span>
      <span
        className="font-select-option-sample"
        style={{ fontFamily: option.cssFamily }}
      >
        {option.sample}
      </span>
      <div className={styles.optionActions}>
        <FavoriteButton
          busy={busy}
          favorite={favorite}
          label={option.label}
          onToggle={() => onToggleFavorite(option.id)}
        />
        {custom ? (
          <CustomFontRemoveButton
            busy={busy}
            label={option.label}
            onRemove={() => onRemove(option.id)}
          />
        ) : null}
      </div>
    </div>
  );
}

function FavoriteButton({
  busy,
  favorite,
  label,
  onToggle,
}: {
  busy: boolean;
  favorite: boolean;
  label: string;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <button
      type="button"
      className={`${styles.favorite} ${favorite ? styles.favoriteActive : ""}`}
      title={t(
        favorite ? "fontSelect.unfavoriteFont" : "fontSelect.favoriteFont",
      )}
      aria-label={t(
        favorite
          ? "fontSelect.unfavoriteNamedFont"
          : "fontSelect.favoriteNamedFont",
        { label },
      )}
      aria-pressed={favorite}
      disabled={busy}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
    </button>
  );
}

function CustomFontRemoveButton({
  busy,
  label,
  onRemove,
}: {
  busy: boolean;
  label: string;
  onRemove: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <button
      type="button"
      className="font-select-remove"
      title={t("fontSelect.deleteFont")}
      aria-label={t("fontSelect.deleteNamedFont", { label })}
      disabled={busy}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRemove();
      }}
    >
      ×
    </button>
  );
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg
      className="font-select-chevron"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="m6 9 6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
