import React from "react";
import { useTranslation } from "react-i18next";
import {
  TEXT_WORD_BREAK_VALUES,
  type TextWordBreak,
} from "../../../shared/textWrapping";

const MIXED_TEXT_WRAPPING_VALUE = "__mixed_text_wrapping__";

export function TextWrappingSelect({
  ariaLabel,
  className,
  disabled = false,
  mixed = false,
  value,
  onChange,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  mixed?: boolean;
  value: TextWordBreak;
  onChange: (value: TextWordBreak) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const descriptionId = React.useId();
  const selectValue = mixed ? MIXED_TEXT_WRAPPING_VALUE : value;
  const description = mixed
    ? t("gatherText.mixedValue")
    : t(`format.wordBreak.descriptions.${value}`);
  return (
    <span className="text-wrapping-select-control">
      <select
        className={className}
        aria-label={ariaLabel}
        aria-describedby={descriptionId}
        value={selectValue}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.value === MIXED_TEXT_WRAPPING_VALUE) return;
          onChange(event.target.value as TextWordBreak);
        }}
      >
        {mixed ? (
          <option value={MIXED_TEXT_WRAPPING_VALUE} disabled>
            {t("gatherText.mixedValue")}
          </option>
        ) : null}
        {TEXT_WORD_BREAK_VALUES.map((option) => (
          <option key={option} value={option}>
            {t(`format.wordBreak.options.${option}`)}
          </option>
        ))}
      </select>
      <small id={descriptionId} className="text-wrapping-select-description">
        {description}
      </small>
    </span>
  );
}
