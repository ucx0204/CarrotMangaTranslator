import React from "react";
import styles from "./ProgressBar.module.css";

export type ProgressBarProps = {
  label: string;
  mode?: "determinate" | "indeterminate";
  value?: number;
  max?: number;
  valueText?: string;
  className?: string;
};

export function ProgressBar({
  label,
  mode = "determinate",
  value = 0,
  max = 1,
  valueText,
  className,
}: ProgressBarProps): React.JSX.Element {
  const determinate = mode === "determinate";
  const safeMax = Number.isFinite(max) && max > 0 ? max : 1;
  const safeValue = Number.isFinite(value)
    ? Math.min(safeMax, Math.max(0, value))
    : 0;
  const ratio = safeValue / safeMax;

  return (
    <div
      className={[styles.track, !determinate && styles.indeterminate, className]
        .filter(Boolean)
        .join(" ")}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? safeMax : undefined}
      aria-valuenow={determinate ? safeValue : undefined}
      aria-valuetext={valueText}
    >
      <div
        className={styles.fill}
        style={
          determinate ? { width: `${Math.round(ratio * 100)}%` } : undefined
        }
      />
    </div>
  );
}
