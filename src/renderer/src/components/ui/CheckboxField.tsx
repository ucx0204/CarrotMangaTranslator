import React from "react";
import styles from "./CheckboxField.module.css";

/**
 * How the boolean control is presented.
 * - `inline` (default): box beside a label, hugging its content.
 * - `switch`: a sliding toggle. Renders `role="switch"`, not a checkbox.
 * - `bare`: the primitive contributes no layout; the caller's `className` owns
 *   the box. Use when the surrounding grid already positions the parts.
 */
type CheckboxFieldVariant = "inline" | "switch" | "bare";

export type CheckboxFieldProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: React.ReactNode;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
  variant?: CheckboxFieldVariant;
  /**
   * Renders the third "partially selected" state. Ignored by the switch
   * variant, which has no indeterminate equivalent.
   */
  indeterminate?: boolean;
  /**
   * Visually hides the native box while keeping it operable, for selectable
   * cards and tiles whose own artwork shows the state.
   */
  hideInput?: boolean;
  inputClassName?: string;
  /** Extra content after the label, e.g. a trailing value in a row. */
  children?: React.ReactNode;
  /** Forwarded to the label element so callers can key off selection state. */
  dataSelected?: boolean;
  role?: "listitem";
};

/**
 * The single boolean control. Checkbox, tri-state checkbox, switch, and
 * visually-hidden card selector are variants of one contract so focus rings,
 * disabled styling, and label association never diverge.
 */
export function CheckboxField(props: CheckboxFieldProps): React.JSX.Element {
  if (props.variant === "switch") {
    return <SwitchControl {...props} />;
  }
  return <CheckboxControl {...props} />;
}

function CheckboxControl({
  checked,
  onCheckedChange,
  label,
  ariaLabel,
  ariaDescribedBy,
  className,
  disabled = false,
  title,
  variant = "inline",
  indeterminate = false,
  hideInput = false,
  inputClassName,
  children,
  dataSelected,
  role,
}: CheckboxFieldProps): React.JSX.Element {
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label
      className={[variant === "bare" ? "" : styles.root, className]
        .filter(Boolean)
        .join(" ")}
      title={title}
      data-selected={dataSelected === undefined ? undefined : dataSelected}
      role={role}
    >
      <input
        ref={inputRef}
        className={[
          hideInput ? "visually-hidden" : styles.input,
          inputClassName ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      {label === undefined ? null : (
        <span className={styles.label}>{label}</span>
      )}
      {children}
    </label>
  );
}

function SwitchControl({
  checked,
  onCheckedChange,
  label,
  ariaLabel,
  ariaDescribedBy,
  className,
  disabled = false,
  title,
  children,
}: CheckboxFieldProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      title={title}
      disabled={disabled}
      className={[styles.root, styles.switch, className]
        .filter(Boolean)
        .join(" ")}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className={styles.switchTrack} aria-hidden="true">
        <span className={styles.switchThumb} />
      </span>
      {label === undefined ? null : (
        <span className={styles.label}>{label}</span>
      )}
      {children}
    </button>
  );
}
