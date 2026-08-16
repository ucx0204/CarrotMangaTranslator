import React from "react";
import { useTranslation } from "react-i18next";
import {
  TEXT_WORD_BREAK_VALUES,
  type TextWordBreak,
} from "../../../shared/textWrapping";
import { Select } from "./ui/Select";
import type { SelectOption } from "./ui/selectTypes";

const MIXED_TEXT_WRAPPING_VALUE = "__mixed_text_wrapping__";

export function TextWrappingSelect({
  ariaLabel,
  className,
  disabled = false,
  mixed = false,
  showDescription = true,
  value,
  onChange,
}: {
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  mixed?: boolean;
  showDescription?: boolean;
  value: TextWordBreak;
  onChange: (value: TextWordBreak) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const descriptionId = React.useId();
  const selectValue = mixed ? MIXED_TEXT_WRAPPING_VALUE : value;
  const description = mixed
    ? t("gatherText.mixedValue")
    : t(`format.wordBreak.descriptions.${value}`);
  const options: SelectOption[] = [
    ...(mixed
      ? [
          {
            value: MIXED_TEXT_WRAPPING_VALUE,
            label: t("gatherText.mixedValue"),
            disabled: true,
          },
        ]
      : []),
    ...TEXT_WORD_BREAK_VALUES.map((option) => ({
      value: option,
      label: t(`format.wordBreak.options.${option}`),
      description: t(`format.wordBreak.descriptions.${option}`),
    })),
  ];
  return (
    <span className="text-wrapping-select-control">
      <Select
        className={className}
        ariaLabel={ariaLabel}
        ariaDescribedBy={showDescription ? descriptionId : undefined}
        value={selectValue}
        disabled={disabled}
        options={options}
        onValueChange={(nextValue) => {
          if (nextValue === MIXED_TEXT_WRAPPING_VALUE) return;
          onChange(nextValue as TextWordBreak);
        }}
      />
      {showDescription ? (
        <small id={descriptionId} className="text-wrapping-select-description">
          {description}
        </small>
      ) : null}
    </span>
  );
}
