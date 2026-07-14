import React from "react";

type SelectionSurfaceElement = "article" | "button" | "div" | "label";
type SelectionSurfaceVariant = "card" | "row" | "thumbnail";

export function SelectionSurface({
  as = "div",
  children,
  className = "",
  disabled = false,
  selected,
  type,
  variant = "card",
  ...props
}: {
  as?: SelectionSurfaceElement;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  selected: boolean;
  type?: "button" | "reset" | "submit";
  variant?: SelectionSurfaceVariant;
} & React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return React.createElement(
    as,
    {
      ...props,
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
  inputClassName,
  inputType,
  name,
  variant,
  onChange,
}: {
  checked: boolean;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  inputAriaLabel?: string;
  inputClassName?: string;
  inputType: "checkbox" | "radio";
  name?: string;
  variant?: SelectionSurfaceVariant;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <SelectionSurface
      as="label"
      className={className}
      disabled={disabled}
      selected={checked}
      variant={variant}
    >
      <input
        type={inputType}
        className={inputClassName}
        aria-label={inputAriaLabel}
        checked={checked}
        disabled={disabled}
        name={name}
        onChange={(event) => onChange(event.target.checked)}
      />
      {children}
    </SelectionSurface>
  );
}
