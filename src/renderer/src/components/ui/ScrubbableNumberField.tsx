import React from "react";
import { NumberField } from "./NumberField";
import styles from "./ScrubbableNumberField.module.css";

const DRAG_THRESHOLD_PX = 4;
const DEFAULT_SCRUB_RANGE_PX = 320;

type ScrubState = {
  pointerId: number;
  startValue: number;
  startX: number;
  dragged: boolean;
};

export type ScrubbableNumberFieldProps = {
  ariaLabel: string;
  decreaseLabel: string;
  increaseLabel: string;
  max: number;
  min: number;
  onValueChange: (value: number) => void;
  step: number;
  value: number;
  className?: string;
  disabled?: boolean;
  inputClassName?: string;
  inputDisabled?: boolean;
  mixed?: boolean;
  placeholder?: string;
  precision?: number;
  scrubDisabled?: boolean;
  scrubRangePx?: number;
  unit?: string;
  onStep?: (direction: -1 | 1) => void;
};

/** Direct numeric input with step buttons that also scrub horizontally. */
export function ScrubbableNumberField(
  props: ScrubbableNumberFieldProps,
): React.JSX.Element {
  const precision = props.precision ?? resolveStepPrecision(props.step);
  const control = useScrubControl({ ...props, precision });
  return (
    <div
      className={[styles.root, props.className ?? ""].filter(Boolean).join(" ")}
      data-scrubbable-number-field=""
    >
      <ScrubStepButton
        direction={-1}
        label={props.decreaseLabel}
        disabled={
          Boolean(props.disabled) ||
          (!control.scrubbing && control.value <= props.min)
        }
        control={control}
      />
      <span className={styles.inputShell}>
        <NumberField
          className={[styles.input, props.inputClassName ?? ""]
            .filter(Boolean)
            .join(" ")}
          ariaLabel={props.ariaLabel}
          min={props.min}
          max={props.max}
          step={props.step}
          precision={precision}
          value={control.value}
          mixed={props.mixed}
          placeholder={props.placeholder}
          disabled={Boolean(props.disabled || props.inputDisabled)}
          commitMode="blur"
          onValueChange={props.onValueChange}
        />
        {props.unit ? (
          <span className={styles.unit} aria-hidden="true">
            {props.unit}
          </span>
        ) : null}
      </span>
      <ScrubStepButton
        direction={1}
        label={props.increaseLabel}
        disabled={
          Boolean(props.disabled) ||
          (!control.scrubbing && control.value >= props.max)
        }
        control={control}
      />
    </div>
  );
}

type ScrubControlOptions = ScrubbableNumberFieldProps & { precision: number };
type PointerHandlers = Pick<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onPointerCancel" | "onPointerDown" | "onPointerMove" | "onPointerUp"
>;
type ScrubControl = {
  scrubbing: boolean;
  value: number;
  pointerHandlers: PointerHandlers;
  onClick: (
    event: React.MouseEvent<HTMLButtonElement>,
    direction: -1 | 1,
  ) => void;
};

function useScrubControl(options: ScrubControlOptions): ScrubControl {
  const scrubRef = React.useRef<ScrubState | null>(null);
  const suppressClickRef = React.useRef(false);
  const [scrubbing, setScrubbing] = React.useState(false);
  const value = normalizeOptionValue(options);
  const emitValue = (rawValue: number): void => {
    const next = normalizeValue(
      rawValue,
      options.min,
      options.max,
      options.step,
      options.precision,
    );
    if (next !== value) options.onValueChange(next);
  };
  const begin = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (options.disabled || options.scrubDisabled || event.button !== 0) return;
    suppressClickRef.current = false;
    scrubRef.current = {
      pointerId: event.pointerId,
      startValue: value,
      startX: event.clientX,
      dragged: false,
    };
    setScrubbing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const state = scrubRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - state.startX;
    if (!state.dragged && Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;
    state.dragged = true;
    suppressClickRef.current = true;
    const range = Math.max(options.step, options.max - options.min);
    emitValue(
      state.startValue +
        (deltaX / (options.scrubRangePx ?? DEFAULT_SCRUB_RANGE_PX)) * range,
    );
  };
  const end = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (scrubRef.current?.pointerId !== event.pointerId) return;
    scrubRef.current = null;
    setScrubbing(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };
  const cancel = (event: React.PointerEvent<HTMLButtonElement>): void => {
    suppressClickRef.current = false;
    end(event);
  };
  const onClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    direction: -1 | 1,
  ): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      return;
    }
    if (options.onStep) options.onStep(direction);
    else emitValue(value + direction * options.step);
  };
  return {
    scrubbing,
    value,
    onClick,
    pointerHandlers: {
      onPointerCancel: cancel,
      onPointerDown: begin,
      onPointerMove: move,
      onPointerUp: end,
    },
  };
}

function ScrubStepButton({
  control,
  direction,
  disabled,
  label,
}: {
  control: ScrubControl;
  direction: -1 | 1;
  disabled: boolean;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={label}
      title={label}
      disabled={disabled}
      {...control.pointerHandlers}
      onClick={(event) => control.onClick(event, direction)}
    >
      <span aria-hidden="true">{direction < 0 ? "−" : "+"}</span>
    </button>
  );
}

function normalizeValue(
  value: number,
  min: number,
  max: number,
  step: number,
  precision: number,
): number {
  const finite = Number.isFinite(value) ? value : min;
  const clamped = Math.min(max, Math.max(min, finite));
  const stepped = min + Math.round((clamped - min) / step) * step;
  const scale = 10 ** Math.max(0, precision);
  return Math.round(Math.min(max, Math.max(min, stepped)) * scale) / scale;
}

function normalizeOptionValue(options: ScrubControlOptions): number {
  return normalizeValue(
    options.value,
    options.min,
    options.max,
    options.step,
    options.precision,
  );
}

function resolveStepPrecision(step: number): number {
  const decimal = String(step).split(".")[1];
  return decimal?.length ?? 0;
}
