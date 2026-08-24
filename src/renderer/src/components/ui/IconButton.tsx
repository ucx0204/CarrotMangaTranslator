import React from "react";
import styles from "./IconButton.module.css";

/**
 * - `canvas`: chrome that floats over the artwork, borderless and larger, so it
 *   reads as tooling rather than as a panel control.
 * - `dock`: a standalone floating control over the artwork, so unlike `canvas`
 *   it keeps a frame and shadow to separate it from the page.
 */
type IconButtonVariant = "default" | "danger" | "canvas" | "dock";
type IconButtonSize = "sm" | "md" | "lg";

export type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Accessible label — required since the button has no visible text. */
  label: string;
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      variant = "default",
      size = "md",
      label,
      className,
      children,
      type = "button",
      title,
      ...rest
    },
    ref,
  ) {
    const classes = [
      styles.iconButton,
      styles[variant],
      size === "md" ? "" : styles[size],
      className ?? "",
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <button
        ref={ref}
        type={type}
        className={classes}
        aria-label={label}
        // An empty string means "no native tooltip": buttons wrapped in
        // ControlTooltip must not also show the browser's own tooltip.
        title={title === "" ? undefined : (title ?? label)}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
