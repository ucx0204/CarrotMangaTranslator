import React from "react";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", fullWidth = false, iconLeft, iconRight, className, children, type = "button", ...rest },
  ref
) {
  const classes = [
    styles.button,
    styles[variant],
    size === "sm" ? styles.sm : "",
    fullWidth ? styles.fullWidth : "",
    className ?? ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {iconLeft ? <span className={styles.icon}>{iconLeft}</span> : null}
      {children != null ? <span className={styles.label}>{children}</span> : null}
      {iconRight ? <span className={styles.icon}>{iconRight}</span> : null}
    </button>
  );
});
