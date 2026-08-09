import React from "react";

export function SegmentedControl<T extends string>({
  ariaDescribedBy,
  ariaLabel,
  buttonClassName,
  className,
  disabled = false,
  options,
  value,
  onChange,
}: {
  ariaDescribedBy?: string;
  ariaLabel: string;
  buttonClassName?: string;
  className?: string;
  disabled?: boolean;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}): React.JSX.Element {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const activateAt = (index: number): void => {
    const option = options[index];
    if (!option || disabled) return;
    onChange(option.id);
    refs.current[index]?.focus();
  };
  const handleKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % options.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + options.length) % options.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = options.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    activateAt(nextIndex);
  };

  return (
    <div
      className={className}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
    >
      {options.map((option, index) => {
        const checked = option.id === value;
        return (
          <button
            key={option.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={[buttonClassName ?? "", checked ? "active" : ""]
              .filter(Boolean)
              .join(" ")}
            disabled={disabled}
            onClick={() => onChange(option.id)}
            onKeyDown={(event) => handleKeyDown(index, event)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
