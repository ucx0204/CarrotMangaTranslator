import React from "react";
import { createPortal } from "react-dom";
import styles from "./OverflowTooltipText.module.css";

type OverflowTooltipTextProps = {
  children: React.ReactNode;
  className?: string;
  content?: string;
};

type TooltipAnchor = {
  left: number;
  top: number;
  placement: "bottom" | "top";
};

const VIEWPORT_PADDING = 12;
const TOOLTIP_GAP = 8;
const TOOLTIP_MAX_WIDTH = 420;

/** Shows an app-rendered tooltip only when its single-line text is truncated. */
export function OverflowTooltipText({
  children,
  className,
  content,
}: OverflowTooltipTextProps): React.JSX.Element {
  const tooltipId = React.useId();
  const textRef = React.useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = React.useState<TooltipAnchor | null>(null);

  const hideTooltip = React.useCallback(() => setAnchor(null), []);
  const showTooltip = React.useCallback(() => {
    const element = textRef.current;
    if (!content || !element || element.scrollWidth <= element.clientWidth) {
      return;
    }
    setAnchor(resolveTooltipAnchor(element.getBoundingClientRect()));
  }, [content]);

  React.useEffect(() => {
    if (!anchor) return undefined;
    window.addEventListener("resize", hideTooltip);
    window.addEventListener("scroll", hideTooltip, true);
    return () => {
      window.removeEventListener("resize", hideTooltip);
      window.removeEventListener("scroll", hideTooltip, true);
    };
  }, [anchor, hideTooltip]);

  return (
    <>
      <span
        ref={textRef}
        className={className}
        aria-describedby={anchor ? tooltipId : undefined}
        onPointerEnter={showTooltip}
        onPointerLeave={hideTooltip}
        onPointerDown={hideTooltip}
      >
        {children}
      </span>
      {anchor && content
        ? createPortal(
            <span
              id={tooltipId}
              role="tooltip"
              className={styles.tooltip}
              data-placement={anchor.placement}
              style={{ left: anchor.left, top: anchor.top }}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </>
  );
}

function resolveTooltipAnchor(rect: DOMRect): TooltipAnchor {
  const availableWidth = Math.max(0, window.innerWidth - VIEWPORT_PADDING * 2);
  const tooltipWidth = Math.min(TOOLTIP_MAX_WIDTH, availableWidth);
  const maximumLeft = Math.max(
    VIEWPORT_PADDING,
    window.innerWidth - tooltipWidth - VIEWPORT_PADDING,
  );
  const left = Math.min(Math.max(rect.left, VIEWPORT_PADDING), maximumLeft);
  const placement = rect.top >= 64 ? "top" : "bottom";
  return {
    left,
    placement,
    top:
      placement === "top" ? rect.top - TOOLTIP_GAP : rect.bottom + TOOLTIP_GAP,
  };
}
