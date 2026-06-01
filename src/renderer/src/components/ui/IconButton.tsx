import React from "react";
import styles from "./IconButton.module.css";

export type IconButtonVariant = "default" | "danger";
export type IconButtonSize = "sm" | "md";

export type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Accessible label — required since the button has no visible text. */
  label: string;
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = "default", size = "md", label, className, children, type = "button", title, ...rest },
  ref
) {
  const classes = [styles.iconButton, styles[variant], size === "sm" ? styles.sm : "", className ?? ""]
    .filter(Boolean)
    .join(" ");

  return (
    <button ref={ref} type={type} className={classes} aria-label={label} title={title ?? label} {...rest}>
      {children}
    </button>
  );
});
