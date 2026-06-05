import React from "react";
import styles from "./Field.module.css";

function Field({
  label,
  hint,
  children,
  className
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <label className={[styles.field, className ?? ""].filter(Boolean).join(" ")}>
      {label != null ? <span className={styles.label}>{label}</span> : null}
      {children}
      {hint != null ? <span className={styles.hint}>{hint}</span> : null}
    </label>
  );
}

export type TextFieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: React.ReactNode;
  hint?: React.ReactNode;
};

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, className, type = "text", ...rest },
  ref
) {
  return (
    <Field label={label} hint={hint} className={className}>
      <input ref={ref} type={type} {...rest} />
    </Field>
  );
});

export type RangeInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/** A range input whose track is filled up to the current value (via the --range-progress CSS var). */
export function RangeInput({ min = 0, max = 100, value, style, ...rest }: RangeInputProps): React.JSX.Element {
  const lo = Number(min);
  const hi = Number(max);
  const current = Number(value ?? lo);
  const ratio = hi > lo ? ((current - lo) / (hi - lo)) * 100 : 0;
  const progress = Math.max(0, Math.min(100, ratio));
  return (
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      style={{ ...style, "--range-progress": `${progress}%` } as React.CSSProperties}
      {...rest}
    />
  );
}
