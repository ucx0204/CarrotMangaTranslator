import React from "react";
import styles from "./ModalActionBar.module.css";

export function ModalActionBar({
  actions,
  className,
  leading,
}: {
  actions: React.ReactNode;
  className?: string;
  leading?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={[
        styles.root,
        leading ? styles.hasLeading : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {leading ? <div className={styles.leading}>{leading}</div> : null}
      <div className={styles.actions}>{actions}</div>
    </div>
  );
}
