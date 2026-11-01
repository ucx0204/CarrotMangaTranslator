import React from "react";
import { createPortal } from "react-dom";
import styles from "./ControlTooltip.module.css";

/** Opt-in portal presentation for controls inside scrollable settings panels. */
export function FloatingControlTooltip({
  children,
  content,
  className,
  asChild = false,
}: {
  children: React.ReactNode | ((descriptionId: string) => React.ReactNode);
  content: string;
  className?: string;
  asChild?: boolean;
}): React.JSX.Element {
  const id = React.useId();
  const { trigger, bubble, anchor, position, close, open } =
    useFloatingTooltipPosition(content);
  const disabledControl =
    React.isValidElement<{ disabled?: boolean }>(children) &&
    children.props.disabled;
  const control = describeTooltipChild(children, id, content);
  return (
    <>
      {asChild &&
      React.isValidElement<
        React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }
      >(control) ? (
        cloneTooltipControl(control, trigger, open, close)
      ) : (
        <span
          ref={(element) => {
            trigger.current = element;
          }}
          data-control-tooltip=""
          tabIndex={disabledControl ? 0 : undefined}
          aria-describedby={disabledControl ? id : undefined}
          className={[styles.anchor, className].filter(Boolean).join(" ")}
          onPointerEnter={open}
          onPointerLeave={close}
          onFocusCapture={open}
          onBlurCapture={close}
          onPointerDown={close}
          onClickCapture={close}
          onKeyDownCapture={close}
        >
          {control}
        </span>
      )}
      {content &&
        (!asChild || anchor) &&
        createPortal(
          <span
            ref={bubble}
            role="tooltip"
            id={id}
            hidden={!anchor}
            className={styles.bubble}
            style={position}
          >
            {content}
          </span>,
          document.body,
        )}
    </>
  );
}

function describeTooltipChild(
  children: React.ReactNode | ((descriptionId: string) => React.ReactNode),
  id: string,
  content: string,
) {
  if (typeof children === "function") return children(id);
  if (
    !content ||
    !React.isValidElement<{ "aria-describedby"?: string }>(children)
  )
    return children;
  return React.cloneElement(children, {
    "aria-describedby": [children.props["aria-describedby"], id]
      .filter(Boolean)
      .join(" "),
  });
}

function cloneTooltipControl(
  control: React.ReactElement<
    React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }
  >,
  trigger: React.RefObject<HTMLElement | null>,
  open: () => void,
  close: () => void,
) {
  return React.cloneElement(control, {
    ref: (element: HTMLElement | null) => {
      trigger.current = element;
      const ref = control.props.ref;
      if (typeof ref === "function") return ref(element);
      if (ref) ref.current = element;
    },
    onPointerEnter: (event) => {
      control.props.onPointerEnter?.(event);
      open();
    },
    onPointerLeave: (event) => {
      control.props.onPointerLeave?.(event);
      close();
    },
    onFocus: (event) => {
      control.props.onFocus?.(event);
      open();
    },
    onBlur: (event) => {
      control.props.onBlur?.(event);
      close();
    },
    onPointerDown: (event) => {
      control.props.onPointerDown?.(event);
      close();
    },
    onKeyDown: (event) => {
      control.props.onKeyDown?.(event);
      close();
    },
  });
}

function useFloatingTooltipPosition(content: string) {
  const trigger = React.useRef<HTMLElement | null>(null);
  const bubble = React.useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null);
  const [position, setPosition] = React.useState({ left: 0, top: 0 });
  const close = React.useCallback(() => setAnchor(null), []);
  const open = () => {
    if (
      !content ||
      trigger.current?.getAttribute("aria-expanded") === "true" ||
      trigger.current?.querySelector('[aria-expanded="true"]')
    )
      return;
    if (trigger.current) setAnchor(trigger.current.getBoundingClientRect());
  };
  React.useLayoutEffect(() => {
    if (!anchor || !bubble.current) return;
    const rect = bubble.current.getBoundingClientRect();
    const top =
      anchor.bottom + 8 + rect.height <= innerHeight - 12
        ? anchor.bottom + 8
        : anchor.top - rect.height - 8;
    setPosition({
      left: Math.max(12, Math.min(anchor.left, innerWidth - rect.width - 12)),
      top: Math.max(12, top),
    });
  }, [anchor, content]);
  React.useEffect(() => {
    if (!anchor) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onScroll = () => {
      if (trigger.current?.contains(document.activeElement)) {
        setAnchor(trigger.current.getBoundingClientRect());
      } else {
        close();
      }
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", dismiss);
    };
  }, [anchor, close]);
  return { trigger, bubble, anchor, position, close, open };
}
