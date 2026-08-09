import React from "react";
import styles from "./InlineMessage.module.css";

export type InlineMessageProps = {
  title: React.ReactNode;
  detail?: React.ReactNode;
  variant?: "danger" | "warning" | "info" | "success";
  role?: "alert" | "status";
  className?: string;
};

export function InlineMessage({
  title,
  detail,
  variant = "info",
  role = variant === "danger" ? "alert" : "status",
  className,
}: InlineMessageProps): React.JSX.Element {
  return (
    <div
      className={[styles.message, styles[variant], className]
        .filter(Boolean)
        .join(" ")}
      role={role}
    >
      <strong>{title}</strong>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}
