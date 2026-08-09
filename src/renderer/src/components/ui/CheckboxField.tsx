import React from "react";
import styles from "./CheckboxField.module.css";

export type CheckboxFieldProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: React.ReactNode;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  title?: string;
};

export function CheckboxField({
  checked,
  onCheckedChange,
  label,
  ariaLabel,
  className,
  disabled = false,
  title,
}: CheckboxFieldProps): React.JSX.Element {
  return (
    <label
      className={[styles.root, className].filter(Boolean).join(" ")}
      title={title}
    >
      <input
        className={styles.input}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      {label === undefined ? null : (
        <span className={styles.label}>{label}</span>
      )}
    </label>
  );
}
