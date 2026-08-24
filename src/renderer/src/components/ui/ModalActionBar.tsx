import React from "react";
import { Button, type ButtonProps } from "./Button";
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

type ModalAction = {
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
};

/**
 * The dismissing action is always `ghost` so that exactly one button in a
 * footer carries weight. Callers cannot restyle it; only the committing action
 * chooses a variant (`primary` by default, `danger` when destructive).
 */
export function ModalActionButtons({
  cancel,
  confirm,
}: {
  cancel?: ModalAction;
  confirm?: ModalAction & { variant?: ButtonProps["variant"] };
}): React.JSX.Element {
  return (
    <>
      {cancel ? (
        <Button
          variant="ghost"
          disabled={cancel.disabled}
          onClick={cancel.onClick}
        >
          {cancel.label}
        </Button>
      ) : null}
      {confirm ? (
        <Button
          variant={confirm.variant ?? "primary"}
          disabled={confirm.disabled}
          onClick={confirm.onClick}
        >
          {confirm.label}
        </Button>
      ) : null}
    </>
  );
}
