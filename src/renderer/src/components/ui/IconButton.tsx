import React from "react";
import { FloatingControlTooltip } from "./FloatingControlTooltip";
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

    const control = (
      <button
        ref={ref}
        type={type}
        className={classes}
        aria-label={label}
        {...rest}
      >
        {children}
      </button>
    );
    return (
      <FloatingControlTooltip
        asChild
        content={rest["aria-describedby"] ? "" : (title ?? label)}
      >
        {control}
      </FloatingControlTooltip>
    );
  },
);
