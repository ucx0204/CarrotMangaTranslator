import React from "react";
import { useTranslation } from "react-i18next";
import { findAdjacentFocusable } from "./focusOrder";
import styles from "./NumberField.module.css";
import { useNumberFieldDraft } from "./numberFieldDraft";
import { useNumberScrub, type NumberScrubControl } from "./numberFieldScrub";
import { resolveStepPrecision } from "./numberFieldValue";

/**
 * How the numeric input is presented.
 * - `plain` (default): a bare input the caller positions and styles. Use it
 *   where the surrounding stylesheet already skins inputs (settings rows).
 * - `scrubber`: framed input flanked by −/+ buttons that also drag-scrub.
 * - `framed`: the same frame and inline unit without the step buttons, for rows
 *   too tight to spare the 64px they need.
 */
type NumberFieldVariant = "plain" | "scrubber" | "framed";

type NumberFieldBaseProps = {
  ariaLabel: string;
  ariaDescribedBy?: string;
  min: number;
  max: number;
  className?: string;
  commitMode?: "change" | "blur";
  disabled?: boolean;
  inputMode?: "decimal" | "numeric";
  invalid?: boolean;
  mixed?: boolean;
  placeholder?: string;
  precision?: number;
  selectOnFocus?: boolean;
  snapToStep?: boolean;
  step?: number;
  /** Short suffix rendered inside the field (e.g. "px", "%"). */
  unit?: string;
  /** Render without native number steppers while still accepting only numbers. */
  useTextInput?: boolean;
  variant?: NumberFieldVariant;
  /** Extra class for the inner input when a wrapper is rendered. */
  inputClassName?: string;
  /** Disable only the text input, leaving the scrub buttons usable. */
  inputDisabled?: boolean;
  /**
   * Scrubber only: accessible labels for the step buttons. They default to
   * the localized "decrease/increase {ariaLabel}" so the two never share a name.
   */
  decreaseLabel?: string;
  increaseLabel?: string;
  /** Scrubber only: block drag-scrubbing but keep the step buttons. */
  scrubDisabled?: boolean;
  /** Scrubber only: pixels of drag that span the whole min..max range. */
  scrubRangePx?: number;
  /** Scrubber only: override what a step button does. */
  onStep?: (direction: -1 | 1) => void;
};

/**
 * `allowEmpty` turns the field into an optional value: clearing it commits
 * `null` instead of restoring the previous number. Used for settings that mean
 * "leave to the provider default" when blank.
 */
export type NumberFieldProps = NumberFieldBaseProps &
  (
    | {
        allowEmpty?: false;
        value: number;
        onValueChange: (value: number) => void;
      }
    | {
        allowEmpty: true;
        value: number | null;
        onValueChange: (value: number | null) => void;
      }
  );

/**
 * The single numeric input. Owns draft state, clamping, step snapping, unit
 * display, optional-empty handling, and Enter/Escape behavior so no screen has
 * to re-implement them.
 */
export function NumberField(props: NumberFieldProps): React.JSX.Element {
  const emit = useNumberFieldEmitter(props);
  const variant = props.variant ?? "plain";
  if (variant === "scrubber") {
    return <ScrubberNumberField props={props} emit={emit} />;
  }
  if (variant === "framed") {
    return <FramedNumberField props={props} emit={emit} />;
  }
  const input = <NumberInput props={props} emit={emit} />;
  if (!props.unit) {
    return input;
  }
  return <NumberFieldShell emit={emit} inputProps={props} unit={props.unit} />;
}

/** Joins the shell classes shared by the framed and scrubber variants. */
function shellClassName(props: NumberFieldProps, variantClass: string): string {
  return [styles.root, variantClass, props.className ?? ""]
    .filter(Boolean)
    .join(" ");
}

/** Class for the inner input inside either framed variant. */
function innerInputClassName(props: NumberFieldProps): string {
  return [styles.input, props.inputClassName ?? ""].filter(Boolean).join(" ");
}

/** The value box shared by both framed variants: input plus the inline unit. */
function NumberFieldShell({
  emit,
  framed = false,
  inputProps,
  unit,
}: {
  emit: (value: number | null) => void;
  framed?: boolean;
  inputProps: NumberFieldProps;
  unit: string | undefined;
}): React.JSX.Element {
  return (
    <span
      className={[styles.inputShell, framed && unit ? styles.withUnit : ""]
        .filter(Boolean)
        .join(" ")}
      data-ui-number-input-zone=""
      onPointerDown={(event) => {
        const input =
          event.currentTarget.querySelector<HTMLInputElement>("input");
        if (!input || input.disabled || event.target === input) return;
        event.preventDefault();
        input.focus();
      }}
    >
      {framed && unit ? (
        /*
         * An invisible twin of the unit on the left keeps the value centred in
         * the field while the input itself stops short of the real unit, so a
         * long draft scrolls inside the input instead of running under it.
         */
        <span className={styles.unitBalance} aria-hidden="true">
          {unit}
        </span>
      ) : null}
      <NumberInput props={inputProps} emit={emit} />
      {unit ? (
        <span className={styles.unit} aria-hidden="true">
          {unit}
        </span>
      ) : null}
    </span>
  );
}

function FramedNumberField({ props, emit }: InternalProps): React.JSX.Element {
  return (
    <div className={shellClassName(props, styles.framed)}>
      <NumberFieldShell
        emit={emit}
        framed
        unit={props.unit}
        inputProps={{ ...props, className: innerInputClassName(props) }}
      />
    </div>
  );
}

/** Narrows the props union once so the internals can emit `number | null`. */
function useNumberFieldEmitter(
  props: NumberFieldProps,
): (value: number | null) => void {
  return (value: number | null): void => {
    if (value === null) {
      if (props.allowEmpty) props.onValueChange(null);
      return;
    }
    props.onValueChange(value);
  };
}

type InternalProps = {
  props: NumberFieldProps;
  emit: (value: number | null) => void;
};

function ScrubberNumberField({
  props,
  emit,
}: InternalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const step = props.step ?? 1;
  const precision = props.precision ?? resolveStepPrecision(step);
  const control = useNumberScrub({
    disabled: props.disabled,
    max: props.max,
    min: props.min,
    onStep: props.onStep,
    onValueChange: emit,
    precision,
    scrubDisabled: props.scrubDisabled,
    scrubRangePx: props.scrubRangePx,
    step,
    value: props.value ?? props.min,
  });
  const decreaseDisabled = isStepDisabled(props, control, -1);
  const increaseDisabled = isStepDisabled(props, control, 1);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const { onActivate, onBlur } = useStepBoundFocusRescue(
    rootRef,
    decreaseDisabled,
    increaseDisabled,
  );
  return (
    <div
      ref={rootRef}
      className={shellClassName(props, styles.scrubber)}
      data-scrubbable-number-field=""
      onBlur={onBlur}
    >
      <ScrubStepButton
        control={control}
        direction={-1}
        disabled={decreaseDisabled}
        label={
          props.decreaseLabel ??
          t("format.decreaseValue", { label: props.ariaLabel })
        }
        onActivate={onActivate}
      />
      <NumberFieldShell
        emit={emit}
        framed
        unit={props.unit}
        inputProps={{
          ...props,
          className: innerInputClassName(props),
          commitMode: "blur",
          disabled: Boolean(props.disabled || props.inputDisabled),
          precision,
          step,
          value: control.value,
        }}
      />
      <ScrubStepButton
        control={control}
        direction={1}
        disabled={increaseDisabled}
        label={
          props.increaseLabel ??
          t("format.increaseValue", { label: props.ariaLabel })
        }
        onActivate={onActivate}
      />
    </div>
  );
}

type PendingStepFocus = { direction: -1 | 1; via: "tab" | "click" };

/**
 * A step button turns disabled once the value reaches its bound. When that
 * button holds focus (Tab from the input committed the maximum and landed on
 * "+", or a click on "+" reached it) the browser drops focus to <body>.
 * Keep it where the user was heading: past the button after Tab, back in the
 * value after a click.
 */
function useStepBoundFocusRescue(
  rootRef: React.RefObject<HTMLDivElement | null>,
  decreaseDisabled: boolean,
  increaseDisabled: boolean,
): {
  onActivate: (direction: -1 | 1) => void;
  onBlur: React.FocusEventHandler<HTMLDivElement>;
} {
  const pendingRef = React.useRef<PendingStepFocus | null>(null);
  React.useLayoutEffect(() => {
    const pending = pendingRef.current;
    const root = rootRef.current;
    if (!pending || !root) return;
    const nowDisabled =
      pending.direction < 0 ? decreaseDisabled : increaseDisabled;
    if (!nowDisabled) return;
    pendingRef.current = null;
    const button = root.querySelector<HTMLElement>(
      `[data-step-direction="${pending.direction}"]`,
    );
    const active = document.activeElement;
    if (!button || (active !== button && active !== document.body)) return;
    const target =
      pending.via === "click"
        ? root.querySelector<HTMLInputElement>("input:not(:disabled)")
        : findAdjacentFocusable(button, pending.direction);
    target?.focus();
  }, [decreaseDisabled, increaseDisabled, rootRef]);
  const onActivate = React.useCallback((direction: -1 | 1) => {
    pendingRef.current = { direction, via: "click" };
  }, []);
  const onBlur = React.useCallback(
    (event: React.FocusEvent<HTMLDivElement>) => {
      const next = event.relatedTarget;
      const direction =
        next instanceof HTMLElement && event.currentTarget.contains(next)
          ? Number(next.dataset.stepDirection)
          : Number.NaN;
      pendingRef.current =
        event.target instanceof HTMLInputElement &&
        (direction === -1 || direction === 1)
          ? { direction, via: "tab" }
          : null;
    },
    [],
  );
  return { onActivate, onBlur };
}

/** A step button is inert at the matching bound, but stays live mid-scrub. */
function isStepDisabled(
  props: NumberFieldProps,
  control: NumberScrubControl,
  direction: -1 | 1,
): boolean {
  if (props.disabled) return true;
  if (control.scrubbing) return false;
  return direction < 0
    ? control.value <= props.min
    : control.value >= props.max;
}

function ScrubStepButton({
  control,
  direction,
  disabled,
  label,
  onActivate,
}: {
  control: NumberScrubControl;
  direction: -1 | 1;
  disabled: boolean;
  label: string;
  onActivate: (direction: -1 | 1) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={label}
      title={label}
      disabled={disabled}
      data-step-direction={direction}
      {...control.pointerHandlers}
      onClick={(event) => {
        onActivate(direction);
        control.onClick(event, direction);
      }}
    >
      <span aria-hidden="true">{direction < 0 ? "−" : "+"}</span>
    </button>
  );
}

// eslint-disable-next-line complexity -- native-number and text-only numeric inputs intentionally share one accessible field contract
function NumberInput({ props, emit }: InternalProps): React.JSX.Element {
  const step = props.step ?? 1;
  const precision = props.precision ?? resolveStepPrecision(step);
  const {
    ariaLabel,
    min,
    max,
    className,
    commitMode = "blur",
    disabled = false,
    inputMode = "decimal",
    invalid = false,
    mixed = false,
    placeholder,
    selectOnFocus = false,
    snapToStep = false,
    useTextInput = false,
  } = props;
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const {
    value: draftValue,
    onBlur,
    onChange,
    onKeyDown,
  } = useNumberFieldDraft({
    allowEmpty: Boolean(props.allowEmpty),
    commitMode,
    emit,
    inputRef,
    max,
    min,
    mixed,
    precision,
    snapToStep,
    step,
    value: props.value,
  });

  return (
    <input
      ref={inputRef}
      className={[styles.numberInput, className ?? ""]
        .filter(Boolean)
        .join(" ")}
      type={useTextInput ? "text" : "number"}
      inputMode={inputMode}
      aria-label={ariaLabel}
      aria-describedby={props.ariaDescribedBy}
      aria-invalid={invalid || undefined}
      min={min}
      max={max}
      step={step}
      value={draftValue}
      placeholder={mixed ? (placeholder ?? "—") : placeholder}
      disabled={disabled}
      /*
       * Marks the inputs whose frame the primitive already draws, so the global
       * `input { border; background; min-height }` baseline skips them. A data
       * attribute rather than a class list means a new framed field never has to
       * be registered in `foundations.css` to avoid a double border.
       */
      data-ui-framed-input={
        props.variant === "scrubber" || props.variant === "framed"
          ? ""
          : undefined
      }
      pattern={resolveNumericInputPattern(useTextInput, inputMode, min)}
      onChange={(event) => {
        if (
          useTextInput &&
          !isAllowedNumericDraft(event.target.value, inputMode, min < 0)
        ) {
          return;
        }
        onChange(event);
      }}
      onBlur={onBlur}
      onFocus={(event) => {
        if (selectOnFocus) event.currentTarget.select();
      }}
      onKeyDown={onKeyDown}
    />
  );
}

function resolveNumericInputPattern(
  useTextInput: boolean,
  inputMode: "decimal" | "numeric",
  min: number,
): string | undefined {
  if (!useTextInput) return undefined;
  const sign = min < 0 ? "-?" : "";
  return inputMode === "numeric" ? `${sign}[0-9]*` : `${sign}[0-9]*[.]?[0-9]*`;
}

function isAllowedNumericDraft(
  value: string,
  inputMode: "decimal" | "numeric",
  allowNegative: boolean,
): boolean {
  const sign = allowNegative ? "-?" : "";
  return inputMode === "numeric"
    ? new RegExp(`^${sign}\\d*$`).test(value)
    : new RegExp(`^${sign}\\d*(?:\\.\\d*)?$`).test(value);
}
