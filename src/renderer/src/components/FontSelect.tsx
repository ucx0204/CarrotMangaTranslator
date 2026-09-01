import React from "react";
import { IconSettings } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { FontManagerModal } from "./FontManagerModal";
import styles from "./FontSelect.module.css";
import { Select } from "./ui/Select";
import { FavoriteToggleButton } from "./ui/FavoriteToggleButton";
import type { SelectOption } from "./ui/selectTypes";
import {
  useFontSelectModel,
  type FontOption,
  type FontSelectModel,
  type FontSelectProps,
} from "./fontSelectModel";

/**
 * Font picker. Registration, deletion, ordering, and visibility live in the
 * adjacent manager; the picker keeps only selection and quick favourites.
 */
export function FontSelect(props: FontSelectProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const model = useFontSelectModel(props);
  const [managerOpen, setManagerOpen] = React.useState(false);
  const options = useFontSelectOptions(model);
  const openManager = props.onOpenManager ?? (() => setManagerOpen(true));
  return (
    <>
      <div className={styles.control}>
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
          value={model.selected.id}
          onValueChange={model.onCommit}
        />
        <button
          type="button"
          className={styles.manage}
          aria-label={t("fontSelect.manageFonts")}
          title={t("fontSelect.manageFonts")}
          disabled={model.busy}
          onClick={openManager}
        >
          <IconSettings size={16} aria-hidden="true" />
        </button>
      </div>
      {!props.onOpenManager && managerOpen ? (
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
            favorite={model.favoriteIds.has(option.id)}
            option={option}
            onToggleFavorite={model.onToggleFavorite}
          />
        ),
      })),
    [model],
  );
}

function FontOptionActions({
  busy,
  favorite,
  option,
  onToggleFavorite,
}: {
  busy: boolean;
  favorite: boolean;
  option: FontOption;
  onToggleFavorite: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <FavoriteToggleButton
      favorite={favorite}
      disabled={busy}
      label={t(
        favorite
          ? "fontSelect.unfavoriteNamedFont"
          : "fontSelect.favoriteNamedFont",
        { label: option.label },
      )}
      onToggle={() => onToggleFavorite(option.id)}
    />
  );
}
