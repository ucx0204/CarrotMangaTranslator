import React from "react";
import { FloatingControlTooltip } from "./FloatingControlTooltip";
import styles from "./Button.module.css";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "bare";
type ButtonSize = "sm" | "md";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      fullWidth = false,
      iconLeft,
      iconRight,
      className,
      children,
      type = variant === "bare" ? undefined : "button",
      title,
      ...rest
    },
    ref,
  ) {
    const helpTitle = rest["aria-describedby"] ? "" : (title ?? "");
    if (variant === "bare") {
      const control = (
        <button
          ref={ref}
          type={type}
          className={[styles.bare, className].filter(Boolean).join(" ")}
          {...rest}
        >
          {iconLeft}
          {children}
          {iconRight}
        </button>
      );
      return (
        <FloatingControlTooltip asChild content={helpTitle}>
          {control}
        </FloatingControlTooltip>
      );
    }
    const classes = [
      styles.button,
      styles[variant],
      size === "sm" ? styles.sm : "",
      fullWidth ? styles.fullWidth : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");

    const control = (
      <button ref={ref} type={type} className={classes} {...rest}>
        <ButtonContents iconLeft={iconLeft} iconRight={iconRight}>
          {children}
        </ButtonContents>
      </button>
    );
    return (
      <FloatingControlTooltip asChild content={helpTitle}>
        {control}
      </FloatingControlTooltip>
    );
  },
);

function ButtonContents({
  iconLeft,
  iconRight,
  children,
}: Pick<ButtonProps, "iconLeft" | "iconRight" | "children">) {
  return (
    <>
      {iconLeft ? <span className={styles.icon}>{iconLeft}</span> : null}
      {children != null ? (
        <span className={styles.label}>{children}</span>
      ) : null}
      {iconRight ? <span className={styles.icon}>{iconRight}</span> : null}
    </>
  );
}
