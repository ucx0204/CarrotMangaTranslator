import React from "react";
import { useTranslation } from "react-i18next";
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

type ModalSize = "sm" | "md" | "lg" | "xl";

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
  const titleId = React.useId();
  const accessibleName = resolveModalAccessibleName(title, ariaLabel, titleId);
  const showHeader = Boolean(title) || Boolean(headerExtra) || Boolean(onClose);
  const handleCardKeyDown = useModalFocusTrap(cardRef);

  useModalEscapeClose({ closeDisabled, closeOnEsc, onClose });
  useModalInitialFocus(cardRef);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (
          onClose &&
          shouldCloseFromBackdrop(event, { closeDisabled, closeOnBackdrop })
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
        {...accessibleName}
        tabIndex={-1}
        onKeyDown={handleCardKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {showHeader ? (
          <ModalHeader
            closeDisabled={closeDisabled}
            headerExtra={headerExtra}
            onClose={onClose}
            title={title}
            titleId={titleId}
          />
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

function resolveModalAccessibleName(
  title: React.ReactNode,
  ariaLabel: string | undefined,
  titleId: string,
): { "aria-label"?: string; "aria-labelledby"?: string } {
  return title ? { "aria-labelledby": titleId } : { "aria-label": ariaLabel };
}

function useModalEscapeClose({
  closeDisabled,
  closeOnEsc,
  onClose,
}: Pick<ModalProps, "closeDisabled" | "closeOnEsc" | "onClose">): void {
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
}

function useModalInitialFocus(
  cardRef: React.RefObject<HTMLDivElement | null>,
): void {
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
  }, [cardRef]);
}

function useModalFocusTrap(
  cardRef: React.RefObject<HTMLDivElement | null>,
): (event: React.KeyboardEvent<HTMLDivElement>) => void {
  return React.useCallback(
    (event) => {
      if (event.key !== "Tab") {
        return;
      }
      const card = cardRef.current;
      if (!card) {
        return;
      }
      trapTabFocus(event, getFocusable(card));
    },
    [cardRef],
  );
}

function trapTabFocus(
  event: React.KeyboardEvent<HTMLDivElement>,
  focusable: HTMLElement[],
): void {
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
}

function shouldCloseFromBackdrop(
  event: React.MouseEvent<HTMLDivElement>,
  {
    closeDisabled,
    closeOnBackdrop,
  }: Pick<ModalProps, "closeDisabled" | "closeOnBackdrop">,
): boolean {
  return (
    Boolean(closeOnBackdrop) &&
    !closeDisabled &&
    event.target === event.currentTarget
  );
}

function ModalHeader({
  closeDisabled,
  headerExtra,
  onClose,
  title,
  titleId,
}: Pick<ModalProps, "closeDisabled" | "headerExtra" | "onClose" | "title"> & {
  titleId: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className={styles.header}>
      {title ? (
        <h2 id={titleId} className={styles.title}>
          {title}
        </h2>
      ) : (
        <span />
      )}
      <div className={styles.headerActions}>
        {headerExtra}
        {onClose ? (
          <IconButton
            label={t("common.close")}
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
  );
}
