import React from "react";
import { createPortal } from "react-dom";
import { SelectionCard } from "./ui/SelectionCard";

export type PageThumbSelectionState = "none" | "restart" | "resume";

export function PageThumbSelectionCard({
  checked,
  children,
  className,
  onToggle,
  selectionState,
  selectionTooltip,
}: {
  checked: boolean;
  children: React.ReactNode;
  className: string;
  onToggle: () => void;
  selectionState?: PageThumbSelectionState;
  selectionTooltip?: string;
}): React.JSX.Element {
  const tooltipId = React.useId();
  const resolvedSelectionState =
    selectionState ?? (checked ? "restart" : "none");
  const hasResumeTooltip =
    resolvedSelectionState === "resume" && Boolean(selectionTooltip);
  const resumeTooltip = useResumeTooltip(
    hasResumeTooltip,
    tooltipId,
    selectionTooltip,
  );
  return (
    <>
      <SelectionCard
        className={className}
        variant="thumbnail"
        inputType="checkbox"
        inputClassName="translate-page-thumb-check"
        inputAriaDescribedBy={hasResumeTooltip ? tooltipId : undefined}
        checked={resolvedSelectionState === "restart"}
        indeterminate={resolvedSelectionState === "resume"}
        surfaceRef={resumeTooltip.surfaceRef}
        onBlurCapture={resumeTooltip.onBlurCapture}
        onChange={onToggle}
        onFocusCapture={resumeTooltip.onFocusCapture}
        onMouseEnter={resumeTooltip.onMouseEnter}
        onMouseLeave={resumeTooltip.onMouseLeave}
      >
        {children}
      </SelectionCard>
      {resumeTooltip.portal}
    </>
  );
}

type TooltipPosition = { left: number; top: number };

function useResumeTooltip(
  enabled: boolean,
  id: string,
  text: string | undefined,
) {
  const [hovered, setHovered] = React.useState(false);
  const [focusWithin, setFocusWithin] = React.useState(false);
  const open = enabled && (hovered || focusWithin);
  const anchored = useAnchoredTooltipPosition(open);
  return {
    surfaceRef: anchored.surfaceRef,
    onBlurCapture: (event: React.FocusEvent<HTMLElement>) =>
      setFocusWithin(event.currentTarget.contains(event.relatedTarget)),
    onFocusCapture: () => setFocusWithin(true),
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    portal: (
      <ResumeTooltipPortal
        enabled={enabled}
        id={id}
        open={open}
        position={anchored.position}
        text={text}
        tooltipRef={anchored.tooltipRef}
      />
    ),
  };
}

function useAnchoredTooltipPosition(open: boolean): {
  position: TooltipPosition | null;
  surfaceRef: React.RefObject<HTMLElement | null>;
  tooltipRef: React.RefObject<HTMLSpanElement | null>;
} {
  const surfaceRef = React.useRef<HTMLElement>(null);
  const tooltipRef = React.useRef<HTMLSpanElement>(null);
  const [position, setPosition] = React.useState<TooltipPosition | null>(null);
  const update = React.useCallback(() => {
    setPosition(
      calculateTooltipPosition(surfaceRef.current, tooltipRef.current),
    );
  }, []);
  React.useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, update]);
  return { position, surfaceRef, tooltipRef };
}

function calculateTooltipPosition(
  surface: HTMLElement | null,
  tooltip: HTMLElement | null,
): TooltipPosition | null {
  if (!surface || !tooltip) return null;
  const gutter = 12;
  const anchorRect = surface.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const maxLeft = Math.max(
    gutter,
    window.innerWidth - tooltipRect.width - gutter,
  );
  const left = Math.min(Math.max(anchorRect.left + 8, gutter), maxLeft);
  const preferredTop = anchorRect.top + 40;
  const top =
    preferredTop + tooltipRect.height <= window.innerHeight - gutter
      ? preferredTop
      : Math.max(gutter, anchorRect.top - tooltipRect.height - 8);
  return { left, top };
}

function ResumeTooltipPortal({
  enabled,
  id,
  open,
  position,
  text,
  tooltipRef,
}: {
  enabled: boolean;
  id: string;
  open: boolean;
  position: TooltipPosition | null;
  text: string | undefined;
  tooltipRef: React.RefObject<HTMLSpanElement | null>;
}): React.ReactNode {
  if (!enabled || !text || typeof document === "undefined") return null;
  return createPortal(
    <span
      ref={tooltipRef}
      className={[
        "translate-page-resume-tooltip",
        open && position ? "is-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      id={id}
      role="tooltip"
      style={{
        left: position?.left ?? -10_000,
        top: position?.top ?? -10_000,
      }}
    >
      {text}
    </span>,
    document.body,
  );
}
