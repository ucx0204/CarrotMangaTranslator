import React from "react";

type SelectionSurfaceElement = "article" | "button" | "div" | "label";
type SelectionSurfaceVariant = "card" | "row" | "thumbnail";

export function SelectionSurface({
  as = "div",
  children,
  className = "",
  disabled = false,
  elementRef,
  selected,
  type,
  variant = "card",
  ...props
}: {
  as?: SelectionSurfaceElement;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  elementRef?: React.Ref<HTMLElement>;
  selected: boolean;
  type?: "button" | "reset" | "submit";
  variant?: SelectionSurfaceVariant;
} & React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return React.createElement(
    as,
    {
      ...props,
      ref: elementRef,
      ...(as === "button" ? { disabled, type: type ?? "button" } : {}),
      className: [
        "selection-surface",
        `selection-surface-${variant}`,
        selected ? "selected" : "",
        className,
      ]
        .filter(Boolean)
        .join(" "),
      "data-disabled": disabled || undefined,
      "data-selected": selected,
    },
    children,
  );
}

export function SelectionCard({
  checked,
  children,
  className,
  disabled = false,
  inputAriaLabel,
  inputAriaDescribedBy,
  inputClassName,
  inputType,
  indeterminate = false,
  name,
  surfaceRef,
  variant,
  onBlurCapture,
  onChange,
  onFocusCapture,
  onMouseEnter,
  onMouseLeave,
}: {
  checked: boolean;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  inputAriaLabel?: string;
  inputAriaDescribedBy?: string;
  inputClassName?: string;
  inputType: "checkbox" | "radio";
  indeterminate?: boolean;
  name?: string;
  surfaceRef?: React.Ref<HTMLElement>;
  variant?: SelectionSurfaceVariant;
  onBlurCapture?: React.FocusEventHandler<HTMLElement>;
  onChange: (checked: boolean) => void;
  onFocusCapture?: React.FocusEventHandler<HTMLElement>;
  onMouseEnter?: React.MouseEventHandler<HTMLElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLElement>;
}): React.JSX.Element {
  return (
    <SelectionSurface
      as="label"
      className={className}
      disabled={disabled}
      elementRef={surfaceRef}
      selected={checked || indeterminate}
      variant={variant}
      onBlurCapture={onBlurCapture}
      onFocusCapture={onFocusCapture}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-selection-state={
        indeterminate ? "resume" : checked ? "restart" : "none"
      }
    >
      <input
        ref={(element) => {
          if (element && inputType === "checkbox") {
            element.indeterminate = indeterminate;
          }
        }}
        type={inputType}
        className={inputClassName}
        aria-label={inputAriaLabel}
        aria-describedby={inputAriaDescribedBy}
        aria-checked={indeterminate ? "mixed" : checked}
        checked={checked}
        disabled={disabled}
        name={name}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </SelectionSurface>
  );
}
