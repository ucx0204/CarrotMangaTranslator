import React from "react";
import styles from "./FavoriteToggleButton.module.css";

export function FavoriteToggleButton({
  favorite,
  label,
  disabled,
  onToggle,
}: {
  favorite: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.button}
      title={label}
      aria-label={label}
      aria-pressed={favorite}
      disabled={disabled}
      onClick={onToggle}
    >
      <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
    </button>
  );
}
