import React from "react";
import { useTranslation } from "react-i18next";
import { clampOriginalImageOpacity } from "../lib/originalImageOpacity";
import { ControlTooltip } from "./ui/ControlTooltip";

export type WorkspaceOriginalOpacityControlProps = {
  available: boolean;
  opacity: number;
  pageId: string | null;
  onChange: (opacity: number) => void;
};

type OriginalOpacityLabels = {
  hideControl: string;
  label: string;
  original: string;
  showControl: string;
  unavailable: string;
};

/** Page-original blend control anchored below the workspace view control. */
export function WorkspaceOriginalOpacityControl({
  available,
  opacity,
  pageId,
  onChange,
}: WorkspaceOriginalOpacityControlProps): React.JSX.Element {
  const labels = useOriginalOpacityLabels();
  const percentage = Math.round(clampOriginalImageOpacity(opacity) * 100);
  const { open, rootRef, sliderRef, toggle, triggerRef } =
    useOriginalOpacityPopup({ available, pageId });
  const panelId = React.useId();
  const sliderId = React.useId();
  const tooltip = available
    ? open
      ? labels.hideControl
      : labels.showControl
    : labels.unavailable;
  return (
    <div
      ref={rootRef}
      className={`workspace-original-opacity-dock ${open ? "open" : ""} ${percentage > 0 ? "active" : ""}`.trim()}
      style={
        {
          "--original-opacity-percent": `${percentage}%`,
        } as React.CSSProperties
      }
    >
      <ControlTooltip
        className="workspace-original-opacity-trigger"
        content={tooltip}
        placement="left"
      >
        <button
          ref={triggerRef}
          type="button"
          aria-controls={panelId}
          aria-expanded={open}
          aria-label={open ? labels.hideControl : labels.showControl}
          disabled={!available}
          onClick={toggle}
        >
          <OriginalBlendIcon opacity={percentage / 100} />
        </button>
      </ControlTooltip>
      {open ? (
        <div
          aria-label={labels.label}
          className="workspace-original-opacity-panel"
          id={panelId}
          role="group"
        >
          <label htmlFor={sliderId}>{labels.original}</label>
          <input
            ref={sliderRef}
            id={sliderId}
            type="range"
            aria-label={labels.label}
            min={0}
            max={100}
            step={1}
            value={percentage}
            onChange={(event) => onChange(Number(event.target.value) / 100)}
          />
          <output htmlFor={sliderId}>{percentage}%</output>
        </div>
      ) : null}
    </div>
  );
}

function useOriginalOpacityPopup({
  available,
  pageId,
}: Pick<WorkspaceOriginalOpacityControlProps, "available" | "pageId">): {
  open: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
  sliderRef: React.RefObject<HTMLInputElement | null>;
  toggle: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
} {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const sliderRef = React.useRef<HTMLInputElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => setOpen(false), [available, pageId]);
  React.useLayoutEffect(() => {
    if (open) sliderRef.current?.focus();
  }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    const handlePointerDown = (event: PointerEvent): void => {
      if (!containsEventTarget(rootRef.current, event.target)) close();
    };
    const handleFocusIn = (event: FocusEvent): void => {
      if (!containsEventTarget(rootRef.current, event.target)) close();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("focusin", handleFocusIn, true);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return {
    open,
    rootRef,
    sliderRef,
    toggle: React.useCallback(() => {
      if (available) setOpen((current) => !current);
    }, [available]),
    triggerRef,
  };
}

function containsEventTarget(
  root: HTMLElement | null,
  target: EventTarget | null,
): boolean {
  return Boolean(root && target instanceof Node && root.contains(target));
}

/** Two overlapping page frames with a live blend fill instead of a stock icon. */
function OriginalBlendIcon({
  opacity,
}: {
  opacity: number;
}): React.JSX.Element {
  const blendOpacity = 0.12 + Math.min(1, Math.max(0, opacity)) * 0.5;
  return (
    <svg
      aria-hidden="true"
      className="workspace-original-opacity-icon"
      fill="none"
      viewBox="0 0 24 24"
    >
      <rect
        x="3.5"
        y="3.5"
        width="12"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.7"
        opacity="0.55"
      />
      <rect
        x="8.5"
        y="6.5"
        width="12"
        height="14"
        rx="2"
        fill="currentColor"
        fillOpacity="0.06"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M8.5 20.5v-14h12z" fill="currentColor" opacity={blendOpacity} />
      <path
        d="m8.8 20.2 11.4-13.4"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <path
        d="M11.4 9.2h2.8v2.8h-2.8zm5.6 0h2.8v2.8H17zm-2.8 2.8H17v2.8h-2.8zm-2.8 2.8h2.8v2.8h-2.8z"
        fill="currentColor"
        opacity="0.28"
      />
    </svg>
  );
}

function useOriginalOpacityLabels(): OriginalOpacityLabels {
  const { t } = useTranslation("components");
  return React.useMemo(
    () => ({
      hideControl: t("workspace.originalOpacity.hideControl"),
      label: t("workspace.originalOpacity.label"),
      original: t("workspace.originalOpacity.original"),
      showControl: t("workspace.originalOpacity.showControl"),
      unavailable: t("workspace.originalOpacity.unavailable"),
    }),
    [t],
  );
}
