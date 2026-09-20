import React from "react";
import { RangeInput, type RangeInputProps } from "./Field";
import styles from "./FieldSlider.module.css";

export type FieldSliderProps = RangeInputProps & {
  /** Localized label shown at the leading edge. */
  label: string;
  layout?: "row" | "stacked";
  /** Pre-formatted value text shown at the trailing edge (e.g. "88%", "1.18"). */
  valueLabel: React.ReactNode;
};

/** A compact slider whose label column can wrap longer translations. */
export function FieldSlider({
  label,
  layout = "row",
  valueLabel,
  className,
  ...rest
}: FieldSliderProps): React.JSX.Element {
  return (
    <div
      className={[
        styles.row,
        layout === "stacked" ? styles.stacked : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={styles.label}>{label}</span>
      <RangeInput aria-label={label} {...rest} />
      <span className={styles.value}>{valueLabel}</span>
    </div>
  );
}
