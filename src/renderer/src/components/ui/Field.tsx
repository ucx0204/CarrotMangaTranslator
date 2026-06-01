import React from "react";
import styles from "./Field.module.css";

/** Generic labelled wrapper for a custom control. */
export function Field({
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

export type TextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: React.ReactNode;
  hint?: React.ReactNode;
};

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, hint, className, ...rest },
  ref
) {
  return (
    <Field label={label} hint={hint} className={className}>
      <textarea ref={ref} {...rest} />
    </Field>
  );
});

export type SelectFieldProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  label?: React.ReactNode;
  hint?: React.ReactNode;
};

export const SelectField = React.forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, hint, className, children, ...rest },
  ref
) {
  return (
    <Field label={label} hint={hint} className={className}>
      <select ref={ref} {...rest}>
        {children}
      </select>
    </Field>
  );
});

export type SliderProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label?: React.ReactNode;
  /** Formatted value shown beside the label (e.g. "28px", "70%"). */
  valueLabel?: React.ReactNode;
};

export function Slider({ label, valueLabel, className, ...rest }: SliderProps): React.JSX.Element {
  return (
    <label className={[styles.field, className ?? ""].filter(Boolean).join(" ")}>
      {label != null || valueLabel != null ? (
        <span className={styles.sliderHead}>
          <span>{label}</span>
          {valueLabel != null ? <strong className={styles.value}>{valueLabel}</strong> : null}
        </span>
      ) : null}
      <input type="range" {...rest} />
    </label>
  );
}

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  label: React.ReactNode;
};

export function Checkbox({ label, className, ...rest }: CheckboxProps): React.JSX.Element {
  return (
    <label className={[styles.checkbox, className ?? ""].filter(Boolean).join(" ")}>
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}
