import React from "react";
import styles from "./SegmentedControl.module.css";
import { useRovingFocus, type RovingFocus } from "./useRovingFocus";

export type SegmentedOption<T extends string> = {
  id: T;
  label: string;
  /** App-rendered help shown when this specific choice is hovered or focused. */
  tooltip?: string;
  /** Optional trailing count, e.g. how many pages match a filter. */
  badge?: React.ReactNode;
  disabled?: boolean;
};

type SegmentedTooltipPlacement = "bottom" | "top";

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
  tooltipPlacement = "bottom",
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
  tooltipPlacement?: SegmentedTooltipPlacement;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}): React.JSX.Element {
  const tooltipBaseId = React.useId();
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
      {options.map((option, index) => (
        <SegmentedControlOption
          key={option.id}
          buttonClassName={buttonClassName}
          checked={option.id === value}
          disabled={disabled}
          index={index}
          onSelect={() => onChange(option.id)}
          option={option}
          roving={roving}
          tooltipPlacement={tooltipPlacement}
          tooltipId={
            option.tooltip ? `${tooltipBaseId}-option-${index}` : undefined
          }
        />
      ))}
    </div>
  );
}

function SegmentedControlOption<T extends string>({
  buttonClassName,
  checked,
  disabled,
  index,
  onSelect,
  option,
  roving,
  tooltipId,
  tooltipPlacement,
}: {
  buttonClassName?: string;
  checked: boolean;
  disabled: boolean;
  index: number;
  onSelect: () => void;
  option: SegmentedOption<T>;
  roving: RovingFocus;
  tooltipId?: string;
  tooltipPlacement: SegmentedTooltipPlacement;
}): React.JSX.Element {
  return (
    <span
      className={[
        styles.option,
        option.tooltip
          ? `control-tooltip control-tooltip-${tooltipPlacement}`
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        ref={roving.register(index)}
        type="button"
        role="radio"
        aria-checked={checked}
        aria-describedby={tooltipId}
        tabIndex={checked ? 0 : -1}
        className={[
          styles.button,
          buttonClassName ?? "",
          checked ? "active" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        disabled={disabled || option.disabled}
        onClick={onSelect}
        onKeyDown={(event) => roving.handleKeyDown(index, event)}
      >
        <span>{option.label}</span>
        {option.badge === undefined ? null : (
          <small className={styles.badge}>{option.badge}</small>
        )}
      </button>
      {option.tooltip && tooltipId ? (
        <span className="control-tooltip-bubble" id={tooltipId} role="tooltip">
          {option.tooltip}
        </span>
      ) : null}
    </span>
  );
}
