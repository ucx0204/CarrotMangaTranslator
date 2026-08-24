import React from "react";
import { useTranslation } from "react-i18next";
import { FontManagerModal } from "./FontManagerModal";
import styles from "./FontSelect.module.css";
import { Button } from "./ui/Button";
import { Select } from "./ui/Select";
import type { SelectOption } from "./ui/selectTypes";
import {
  useFontSelectModel,
  type FontOption,
  type FontSelectModel,
  type FontSelectProps,
} from "./fontSelectModel";

/**
 * Font picker. It is `ui/Select` with a sample preview per row, per-row
 * favourite/delete actions, and a menu footer, so it inherits the shared
 * keyboard model, viewport-aware positioning, and focus restoration.
 */
export function FontSelect(props: FontSelectProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useFontSelectModel(props);
  const [managerOpen, setManagerOpen] = React.useState(false);
  const options = useFontSelectOptions(model);
  return (
    <>
      <Select
        ariaLabel={props.ariaLabel ?? t("fontSelect.label")}
        className="font-select"
        disabled={props.disabled}
        options={options}
        searchable="auto"
        triggerExtra={
          <span
            className={styles.triggerSample}
            style={{ fontFamily: model.selected.cssFamily }}
            aria-hidden="true"
          >
            {model.selected.sample}
          </span>
        }
        menuFooter={
          <div className={styles.footer}>
            <Button size="sm" disabled={model.busy} onClick={model.onAddFont}>
              {t("fontSelect.addFont")}
            </Button>
            <Button
              size="sm"
              disabled={model.busy}
              onClick={() => setManagerOpen(true)}
            >
              {t("fontSelect.manageFonts")}
            </Button>
          </div>
        }
        value={model.selected.id}
        onValueChange={model.onCommit}
      />
      {managerOpen ? (
        <FontManagerModal onClose={() => setManagerOpen(false)} />
      ) : null}
    </>
  );
}

function useFontSelectOptions(model: FontSelectModel): SelectOption[] {
  return React.useMemo(
    () =>
      model.options.map((option) => ({
        value: option.id,
        label: option.label,
        searchText: `${option.label} ${option.sample}`,
        preview: (
          <span
            className={styles.optionSample}
            style={{ fontFamily: option.cssFamily }}
            aria-hidden="true"
          >
            {option.sample}
          </span>
        ),
        actions: (
          <FontOptionActions
            busy={model.busy}
            custom={model.customIds.has(option.id)}
            favorite={model.favoriteIds.has(option.id)}
            option={option}
            onRemove={model.onRemoveFont}
            onToggleFavorite={model.onToggleFavorite}
          />
        ),
      })),
    [model],
  );
}

function FontOptionActions({
  busy,
  custom,
  favorite,
  option,
  onRemove,
  onToggleFavorite,
}: {
  busy: boolean;
  custom: boolean;
  favorite: boolean;
  option: FontOption;
  onRemove: (id: string) => void;
  onToggleFavorite: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
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
          { label: option.label },
        )}
        aria-pressed={favorite}
        disabled={busy}
        onClick={() => onToggleFavorite(option.id)}
      >
        <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
      </button>
      {custom ? (
        <button
          type="button"
          className={styles.remove}
          title={t("fontSelect.deleteFont")}
          aria-label={t("fontSelect.deleteNamedFont", { label: option.label })}
          disabled={busy}
          onClick={() => onRemove(option.id)}
        >
          ×
        </button>
      ) : null}
    </>
  );
}
