import React from "react";
import { useTranslation } from "react-i18next";
import styles from "./Modal.module.css";
import { IconButton } from "./IconButton";
import { CloseIcon } from "./icons";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const modalStack: symbol[] = [];

function isTopModal(id: symbol): boolean {
  return modalStack.at(-1) === id;
}

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.offsetParent !== null);
}

type ModalSize = "sm" | "md" | "lg" | "xl";

/**
 * How the scrollable body arranges its children.
 * - `grid` (default): stacked rows with the standard gap and padding.
 * - `flex`: a column that owns its own overflow, for bodies with a scrolling child.
 * - `fill`: the default grid, stretched to the dialog height, for bodies whose
 *   row tracks are sized by the caller.
 * - `bare`: a column with no gap or padding; the caller renders its own shell.
 */
type ModalBodyLayout = "grid" | "flex" | "fill" | "bare";

/**
 * A dialog is named by its visible `title`, or by `ariaLabel` when it has no
 * visible title. Supplying both is a mistake — `title` always wins — so the two
 * are mutually exclusive by type.
 */
type ModalAccessibleName =
  | { title: React.ReactNode; ariaLabel?: never }
  | { title?: undefined; ariaLabel: string };

export type ModalProps = ModalAccessibleName & {
  /** Called by the close button, Esc, and backdrop click (when enabled). Omit to hide the close button. */
  onClose?: () => void;
  /**
   * Keeps the close affordance visible but inert (e.g. while saving).
   * Prefer this over dropping `onClose`, which would remove the close button
   * and silently disable Esc.
   */
  closeDisabled?: boolean;
  /**
   * Opt in only when a stray click cannot destroy work: read-only guides and
   * single-choice confirmations. Dialogs holding typed text, a draft, or a
   * multi-item selection must leave this off.
   */
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  size?: ModalSize;
  /** Explicit CSS width for the dialog card; overrides `size`. */
  width?: string;
  /**
   * Caps the card height, e.g. `"900px"`. The viewport bound is always applied
   * on top of it, so callers must not restate a `calc(100vh - …)` expression.
   */
  maxHeight?: string;
  /**
   * Takes the whole capped height instead of hugging the content, for dialogs
   * whose content streams in and would otherwise resize under the pointer.
   */
  fillHeight?: boolean;
  bodyLayout?: ModalBodyLayout;
  /**
   * Stacking tier. `blocking` lifts the dialog above other dialogs for
   * app-blocking progress that must not be covered.
   */
  elevation?: "dialog" | "blocking";
  /** Extra class applied to the dialog card (e.g. for custom widths). */
  cardClassName?: string;
  /** Extra class applied to the scrollable body. */
  bodyClassName?: string;
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
};

export function Modal(props: ModalProps): React.JSX.Element {
  const { closeDisabled = false, closeOnBackdrop = false, onClose } = props;
  const cardRef = React.useRef<HTMLDivElement | null>(null);
  const [modalId] = React.useState(() => Symbol("modal"));

  useModalStackRegistration(modalId);
  useModalEscapeClose({
    closeDisabled,
    closeOnEsc: props.closeOnEsc ?? true,
    modalId,
    onClose,
  });
  useModalInitialFocus(cardRef);

  return (
    <div
      className={[
        styles.backdrop,
        props.elevation === "blocking" ? styles.backdropBlocking : "",
      ]
        .filter(Boolean)
        .join(" ")}
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
      <ModalCard cardRef={cardRef} modalId={modalId} props={props} />
    </div>
  );
}

function ModalCard({
  cardRef,
  modalId,
  props,
}: {
  cardRef: React.RefObject<HTMLDivElement | null>;
  modalId: symbol;
  props: ModalProps;
}): React.JSX.Element {
  const {
    bodyClassName,
    bodyLayout = "grid",
    cardClassName,
    children,
    closeDisabled = false,
    footer,
    headerExtra,
    onClose,
    size = "md",
    title,
  } = props;
  const titleId = React.useId();
  const handleCardKeyDown = useModalFocusTrap(cardRef, modalId);
  const showHeader = Boolean(title) || Boolean(headerExtra) || Boolean(onClose);
  return (
    <div
      ref={cardRef}
      className={[
        styles.card,
        styles[size],
        props.fillHeight ? styles.cardFillHeight : "",
        cardClassName ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={resolveCardStyle(props.width, props.maxHeight)}
      role="dialog"
      aria-modal="true"
      {...resolveModalAccessibleName(title, props.ariaLabel, titleId)}
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
        className={[
          styles.body,
          bodyLayoutClass(bodyLayout),
          bodyClassName ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </div>
      {footer ? <div className={styles.footer}>{footer}</div> : null}
    </div>
  );
}

function bodyLayoutClass(layout: ModalBodyLayout): string {
  if (layout === "flex") return styles.bodyFlex;
  if (layout === "fill") return styles.bodyFill;
  if (layout === "bare") return styles.bodyBare;
  return "";
}

function resolveCardStyle(
  width: string | undefined,
  maxHeight: string | undefined,
): React.CSSProperties | undefined {
  if (!width && !maxHeight) return undefined;
  return {
    ...(width ? { width } : {}),
    ...(maxHeight ? { "--modal-cap": maxHeight } : {}),
  } as React.CSSProperties;
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
  modalId,
  onClose,
}: Pick<ModalProps, "closeDisabled" | "closeOnEsc" | "onClose"> & {
  modalId: symbol;
}): void {
  const requestClose = useStableModalCallback(() => {
    if (!closeDisabled) {
      onClose?.();
    }
  });
  const enabled = closeOnEsc && Boolean(onClose);
  React.useEffect(() => {
    if (!enabled) {
      return;
    }
    const handle = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && isTopModal(modalId)) {
        requestClose();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [enabled, modalId, requestClose]);
}

function useStableModalCallback(callback: () => void): () => void {
  const callbackRef = React.useRef(callback);
  React.useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  return React.useCallback(() => callbackRef.current(), []);
}

function useModalStackRegistration(modalId: symbol): void {
  React.useEffect(() => {
    modalStack.push(modalId);
    return () => {
      const index = modalStack.lastIndexOf(modalId);
      if (index >= 0) {
        modalStack.splice(index, 1);
      }
    };
  }, [modalId]);
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
      const requested = card.querySelector<HTMLElement>(
        "[data-modal-initial-focus], [autofocus]",
      );
      /*
       * The close button lives before the body in DOM order. Focusing the
       * first generic control therefore opened every dialog with its least
       * important action highlighted in the accent colour. Keep a deliberate
       * autofocus request when a workflow has one; otherwise focus the dialog
       * itself and let the first Tab enter the normal focus order.
       */
      (requested ?? card).focus();
    }
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [cardRef]);
}

function useModalFocusTrap(
  cardRef: React.RefObject<HTMLDivElement | null>,
  modalId: symbol,
): (event: React.KeyboardEvent<HTMLDivElement>) => void {
  return React.useCallback(
    (event) => {
      if (event.key !== "Tab" || !isTopModal(modalId)) {
        return;
      }
      const card = cardRef.current;
      if (!card) {
        return;
      }
      trapTabFocus(event, getFocusable(card));
    },
    [cardRef, modalId],
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
