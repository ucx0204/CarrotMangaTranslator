import React from "react";
import styles from "./SegmentedControl.module.css";
import { useRovingFocus } from "./useRovingFocus";

export type SegmentedOption<T extends string> = {
  id: T;
  label: string;
  /** Optional trailing count, e.g. how many pages match a filter. */
  badge?: React.ReactNode;
  disabled?: boolean;
};

/**
 * A single-select button group. Use this for mode pickers and filters; use
 * `Tabs` only when the buttons actually switch tab panels.
 */
export function SegmentedControl<T extends string>({
  ariaDescribedBy,
  ariaLabel,
  buttonClassName,
  className,
  disabled = false,
  singleRow = false,
  options,
  value,
  onChange,
}: {
  ariaDescribedBy?: string;
  ariaLabel: string;
  buttonClassName?: string;
  className?: string;
  disabled?: boolean;
  /** Keep every option in one horizontal row. Labels may wrap inside a cell. */
  singleRow?: boolean;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}): React.JSX.Element {
  const roving = useRovingFocus({
    count: options.length,
    disabled,
    onActivate: (index) => {
      const option = options[index];
      if (option && !option.disabled) onChange(option.id);
    },
  });

  return (
    <div
      className={[
        styles.group,
        singleRow ? styles.singleRow : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-ui-segmented=""
    >
      {options.map((option, index) => {
        const checked = option.id === value;
        return (
          <button
            key={option.id}
            ref={roving.register(index)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={[
              styles.button,
              buttonClassName ?? "",
              checked ? "active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => roving.handleKeyDown(index, event)}
          >
            <span>{option.label}</span>
            {option.badge === undefined ? null : (
              <small className={styles.badge}>{option.badge}</small>
            )}
          </button>
        );
      })}
    </div>
  );
}
