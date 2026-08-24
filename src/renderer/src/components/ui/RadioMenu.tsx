import React from "react";
import { CheckIcon } from "./icons";
import { MenuSurface } from "./MenuSurface";
import styles from "./RadioMenu.module.css";

export type RadioMenuOption<T extends string> = {
  value: T;
  label: React.ReactNode;
  meta?: React.ReactNode;
  disabled?: boolean;
};

/**
 * Shared single-choice popup menu. Callers own only the trigger and anchoring;
 * menu spacing, selection marks, counts, and keyboard behavior stay identical.
 */
export function RadioMenu<T extends string>({
  ariaLabel,
  className,
  menuRef,
  options,
  value,
  onChange,
  onClose,
}: {
  ariaLabel: string;
  className?: string;
  menuRef: React.RefObject<HTMLDivElement | null>;
  options: readonly RadioMenuOption<T>[];
  value: T;
  onChange: (value: T) => void;
  onClose: (restoreFocus?: boolean) => void;
}): React.JSX.Element {
  return (
    <MenuSurface
      ref={menuRef}
      ariaLabel={ariaLabel}
      className={[styles.surface, className ?? ""].filter(Boolean).join(" ")}
      onClose={onClose}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={selected}
            className={styles.item}
            disabled={option.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(option.value);
              onClose(true);
            }}
          >
            <span
              className={styles.check}
              data-visible={selected || undefined}
              aria-hidden="true"
            >
              <CheckIcon size={14} />
            </span>
            <span className={styles.label}>{option.label}</span>
            {option.meta === undefined ? null : (
              <span className={styles.meta}>{option.meta}</span>
            )}
          </button>
        );
      })}
    </MenuSurface>
  );
}
