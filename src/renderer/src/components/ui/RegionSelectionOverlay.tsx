import React from "react";
import { useTranslation } from "react-i18next";
import {
  RESIZE_DIRECTIONS,
  type ResizeDirection,
} from "../../../../shared/regionSelectionGeometry";
import type { BBox } from "../../../../shared/textTypes";
import styles from "./RegionSelectionOverlay.module.css";

type ControlProps = React.ButtonHTMLAttributes<HTMLButtonElement>;
type Props = {
  bbox: BBox;
  selected: boolean;
  included?: boolean;
  disabled?: boolean;
  label: string;
  children?: React.ReactNode;
  targetProps: ControlProps;
  resizeProps: (direction: ResizeDirection) => ControlProps;
};

/** The SFX candidate frame, shared with region review; no toolbar button paint. */
export function RegionSelectionOverlay({
  bbox,
  selected,
  included = true,
  disabled,
  label,
  children,
  targetProps,
  resizeProps,
}: Props): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div
      className={styles.frame}
      data-region-overlay=""
      data-selected={selected || undefined}
      data-included={included}
      data-disabled={disabled || undefined}
      style={{
        left: `${bbox.x / 10}%`,
        top: `${bbox.y / 10}%`,
        width: `${bbox.w / 10}%`,
        height: `${bbox.h / 10}%`,
      }}
    >
      <button
        {...targetProps}
        type="button"
        className={styles.target}
        disabled={disabled}
        aria-label={label}
      >
        {children}
      </button>
      {selected && !disabled
        ? RESIZE_DIRECTIONS.map((direction) => (
            <button
              {...resizeProps(direction)}
              key={direction}
              type="button"
              className={styles.handle}
              data-resize-handle={direction}
              data-candidate-state={included ? "included" : "excluded"}
              aria-label={t(
                `transform.handles.resize${direction[0].toUpperCase()}${direction.slice(1)}`,
              )}
              onClick={(event) => event.stopPropagation()}
            />
          ))
        : null}
    </div>
  );
}
