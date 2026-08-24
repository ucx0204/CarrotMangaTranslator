import React from "react";
import { normalizeNumberFieldValue } from "./numberFieldValue";

const DRAG_THRESHOLD_PX = 4;
const DEFAULT_SCRUB_RANGE_PX = 320;

type ScrubState = {
  pointerId: number;
  startValue: number;
  startX: number;
  dragged: boolean;
};

export type NumberScrubOptions = {
  disabled?: boolean;
  max: number;
  min: number;
  precision: number;
  scrubDisabled?: boolean;
  scrubRangePx?: number;
  step: number;
  value: number;
  onStep?: (direction: -1 | 1) => void;
  onValueChange: (value: number) => void;
};

type PointerHandlers = Pick<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onPointerCancel" | "onPointerDown" | "onPointerMove" | "onPointerUp"
>;

export type NumberScrubControl = {
  scrubbing: boolean;
  value: number;
  pointerHandlers: PointerHandlers;
  onClick: (
    event: React.MouseEvent<HTMLButtonElement>,
    direction: -1 | 1,
  ) => void;
};

/**
 * Step buttons that also scrub horizontally: dragging maps the full value range
 * onto `scrubRangePx`, and the click that ends a drag is suppressed.
 */
export function useNumberScrub(
  options: NumberScrubOptions,
): NumberScrubControl {
  const scrubRef = React.useRef<ScrubState | null>(null);
  const suppressClickRef = React.useRef(false);
  const [scrubbing, setScrubbing] = React.useState(false);
  const value = normalize(options, options.value);

  const emitValue = (rawValue: number): void => {
    const next = normalize(options, rawValue);
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

function normalize(options: NumberScrubOptions, value: number): number {
  return normalizeNumberFieldValue(
    value,
    options.min,
    options.max,
    options.precision,
    options.step,
    true,
  );
}
