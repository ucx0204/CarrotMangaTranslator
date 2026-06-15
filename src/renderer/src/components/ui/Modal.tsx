import React from "react";
import styles from "./Modal.module.css";
import { IconButton } from "./IconButton";
import { CloseIcon } from "./icons";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.offsetParent !== null);
}

export type ModalSize = "sm" | "md" | "lg" | "xl";

export type ModalProps = {
  title?: React.ReactNode;
  /** Called by the close button, Esc, and backdrop click (when enabled). Omit to hide the close button. */
  onClose?: () => void;
  closeDisabled?: boolean;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  size?: ModalSize;
  /** Explicit CSS width for the dialog card; overrides `size`. */
  width?: string;
  ariaLabel?: string;
  /** Extra class applied to the dialog card (e.g. for custom widths). */
  cardClassName?: string;
  /** Extra class applied to the scrollable body. */
  bodyClassName?: string;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
};

export function Modal({
  title,
  onClose,
  closeDisabled = false,
  closeOnBackdrop = false,
  closeOnEsc = true,
  size = "md",
  width,
  ariaLabel,
  cardClassName,
  bodyClassName,
  headerExtra,
  footer,
  children,
}: ModalProps): React.JSX.Element {
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!closeOnEsc || !onClose) {
      return;
    }
    const handle = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !closeDisabled) {
        onClose();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [closeOnEsc, onClose, closeDisabled]);

  React.useEffect(() => {
    const previouslyFocused =
      typeof document !== "undefined"
        ? (document.activeElement as HTMLElement | null)
        : null;
    const card = cardRef.current;
    if (card) {
      const focusable = getFocusable(card);
      (focusable[0] ?? card).focus();
    }
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  const handleCardKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key !== "Tab") {
      return;
    }
    const card = cardRef.current;
    if (!card) {
      return;
    }
    const focusable = getFocusable(card);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const showHeader = Boolean(title) || Boolean(headerExtra) || Boolean(onClose);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (
          closeOnBackdrop &&
          !closeDisabled &&
          onClose &&
          event.target === event.currentTarget
        ) {
          onClose();
        }
      }}
    >
      <div
        ref={cardRef}
        className={[styles.card, styles[size], cardClassName ?? ""]
          .filter(Boolean)
          .join(" ")}
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={handleCardKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {showHeader ? (
          <div className={styles.header}>
            {title ? <h2 className={styles.title}>{title}</h2> : <span />}
            <div className={styles.headerActions}>
              {headerExtra}
              {onClose ? (
                <IconButton
                  label="닫기"
                  variant="default"
                  size="sm"
                  onClick={onClose}
                  disabled={closeDisabled}
                >
                  <CloseIcon size={16} />
                </IconButton>
              ) : null}
            </div>
          </div>
        ) : null}
        <div
          className={[styles.body, bodyClassName ?? ""]
            .filter(Boolean)
            .join(" ")}
        >
          {children}
        </div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}
