import React from "react";
import styles from "./Field.module.css";

/**
 * How the label sits relative to the control.
 * - `stack` (default): label above the control.
 * - `row`: label beside the control on one baseline.
 * - `inline`: the field hugs its content instead of filling the row.
 */
type FieldVariant = "stack" | "row" | "inline";

/** Label-to-control spacing. Editor surfaces are compact, settings comfortable. */
type FieldDensity = "compact" | "comfortable";

export type FieldProps = {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  labelClassName?: string;
  variant?: FieldVariant;
  density?: FieldDensity;
  /**
   * Render a plain container instead of a `<label>`. Required when the control
   * is not a labelable element — for example the button-based `Select`. Pair it
   * with `labelId` and point the control's `aria-labelledby` at that id.
   */
  as?: "label" | "div";
  labelId?: string;
  /** Container-level key handling, e.g. "Enter submits this settings panel". */
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
};

/**
 * The single label + control + hint layout. Every form row should go through
 * this instead of hand-rolling `<label><span>…` so spacing, type scale, and
 * label association stay consistent across the app.
 */
export function Field({
  label,
  hint,
  children,
  className,
  labelClassName,
  variant = "stack",
  density = "compact",
  as = "label",
  labelId,
  onKeyDown,
}: FieldProps): React.JSX.Element {
  const Container = as;
  const classes = [
    styles.field,
    variant === "row" ? styles.row : "",
    variant === "inline" ? styles.inline : "",
    density === "comfortable" ? styles.comfortable : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Container className={classes} onKeyDown={onKeyDown}>
      {label != null ? (
        <span
          id={labelId}
          className={[styles.label, labelClassName ?? ""]
            .filter(Boolean)
            .join(" ")}
        >
          {label}
        </span>
      ) : null}
      {children}
      {hint != null ? <span className={styles.hint}>{hint}</span> : null}
    </Container>
  );
}

export type TextFieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  density?: FieldDensity;
};

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  function TextField(
    { label, hint, className, density, type = "text", ...rest },
    ref,
  ) {
    return (
      <Field label={label} hint={hint} className={className} density={density}>
        <input ref={ref} type={type} {...rest} />
      </Field>
    );
  },
);

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea(props, ref) {
    return <textarea ref={ref} {...props} />;
  },
);

export type TextareaFieldProps = TextareaProps & {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  density?: FieldDensity;
};

export const TextareaField = React.forwardRef<
  HTMLTextAreaElement,
  TextareaFieldProps
>(function TextareaField({ label, hint, className, density, ...rest }, ref) {
  return (
    <Field label={label} hint={hint} className={className} density={density}>
      <Textarea ref={ref} {...rest} />
    </Field>
  );
});

export type RangeInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  /** Access the underlying slider, e.g. to focus it when a popover opens. */
  inputRef?: React.RefObject<HTMLInputElement | null>;
};

/** A range input whose track is filled up to the current value (via the --range-progress CSS var). */
export function RangeInput({
  className,
  min = 0,
  max = 100,
  value,
  style,
  inputRef,
  ...rest
}: RangeInputProps): React.JSX.Element {
  const lo = Number(min);
  const hi = Number(max);
  const current = Number(value ?? lo);
  const ratio = hi > lo ? ((current - lo) / (hi - lo)) * 100 : 0;
  const progress = Math.max(0, Math.min(100, ratio));
  return (
    <span
      className={["range-input-shell", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      style={
        { ...style, "--range-progress": `${progress}%` } as React.CSSProperties
      }
    >
      <span className="range-input-track" aria-hidden="true" />
      <input
        ref={inputRef}
        className="range-input-control"
        type="range"
        min={min}
        max={max}
        value={value}
        {...rest}
      />
    </span>
  );
}
