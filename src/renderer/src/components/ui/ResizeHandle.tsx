import React from "react";
import styles from "./ResizeHandle.module.css";

const KEYBOARD_STEP_PX = 16;
const KEYBOARD_LARGE_STEP_PX = 64;

export type ResizeHandleProps = {
  /**
   * Separator orientation (WAI-ARIA): `vertical` sits between side-by-side
   * panes and drags horizontally; `horizontal` sits between stacked panes.
   */
  orientation: "vertical" | "horizontal";
  label: string;
  title?: string;
  className?: string;
  valueNow?: number;
  valueMin?: number;
  valueMax?: number;
  valueText?: string;
  /**
   * Reads the current value from layout while `valueNow` is unset, i.e. while
   * the panes keep their default CSS sizes. Without it a separator in the
   * default state would expose a range but no current position.
   */
  measureValue?: (handle: HTMLElement) => number | null;
  /** Snapshots the sizes the following offsets are measured from. */
  onResizeStart: (handle: HTMLElement) => void;
  /** Pointer or keyboard offset from the start, in CSS px along the drag axis. */
  onResize: (offsetPx: number) => void;
  onResizeEnd: () => void;
  /** Double-click restores the default size. */
  onReset: () => void;
};

/**
 * A focusable pane splitter: pointer drag, arrow keys (Shift for larger
 * steps) and double-click to reset. Callers own sizes and clamping.
 */
export function ResizeHandle({
  orientation,
  label,
  title,
  className,
  valueNow,
  valueMin,
  valueMax,
  valueText,
  measureValue,
  onResizeStart,
  onResize,
  onResizeEnd,
  onReset,
}: ResizeHandleProps): React.JSX.Element {
  const dragRef = React.useRef<{ pointerId: number; start: number } | null>(
    null,
  );
  const [dragging, setDragging] = React.useState(false);
  const { handleRef, measured, remeasure } = useMeasuredValue(
    valueNow === undefined ? measureValue : undefined,
  );
  const axis = (event: { clientX: number; clientY: number }): number =>
    orientation === "vertical" ? event.clientX : event.clientY;

  const finish = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    onResizeEnd();
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={valueNow ?? measured ?? undefined}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      aria-valuetext={valueText}
      title={title ?? label}
      data-dragging={dragging || undefined}
      className={[styles.handle, styles[orientation], className ?? ""]
        .filter(Boolean)
        .join(" ")}
      onPointerDown={(event) => {
        if (event.button !== 0 || dragRef.current) return;
        // Keeps the drag from selecting sidebar text.
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, start: axis(event) };
        setDragging(true);
        onResizeStart(event.currentTarget);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        onResize(axis(event) - drag.start);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={onReset}
      onFocus={remeasure}
      onKeyDown={(event) =>
        stepWithKeyboard(event, orientation, {
          onResizeStart,
          onResize,
          onResizeEnd,
        })
      }
    />
  );
}

function stepWithKeyboard(
  event: React.KeyboardEvent<HTMLDivElement>,
  orientation: ResizeHandleProps["orientation"],
  handlers: Pick<
    ResizeHandleProps,
    "onResizeStart" | "onResize" | "onResizeEnd"
  >,
): void {
  const [back, forward] =
    orientation === "vertical"
      ? ["ArrowLeft", "ArrowRight"]
      : ["ArrowUp", "ArrowDown"];
  if (event.key !== back && event.key !== forward) return;
  event.preventDefault();
  const step = event.shiftKey ? KEYBOARD_LARGE_STEP_PX : KEYBOARD_STEP_PX;
  handlers.onResizeStart(event.currentTarget);
  handlers.onResize(event.key === forward ? step : -step);
  handlers.onResizeEnd();
}

function useMeasuredValue(
  measureValue: ((handle: HTMLElement) => number | null) | undefined,
): {
  handleRef: React.RefObject<HTMLDivElement | null>;
  measured: number | null;
  remeasure: () => void;
} {
  const handleRef = React.useRef<HTMLDivElement | null>(null);
  const [measured, setMeasured] = React.useState<number | null>(null);
  const remeasure = React.useCallback(() => {
    const handle = handleRef.current;
    if (!measureValue || !handle) return;
    const next = measureValue(handle);
    setMeasured(next === null ? null : Math.round(next));
  }, [measureValue]);
  React.useLayoutEffect(() => {
    if (!measureValue) {
      setMeasured(null);
      return;
    }
    remeasure();
    const container = handleRef.current?.parentElement;
    const observer =
      container && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(remeasure)
        : null;
    if (container) observer?.observe(container);
    window.addEventListener("resize", remeasure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, [measureValue, remeasure]);
  return { handleRef, measured, remeasure };
}
