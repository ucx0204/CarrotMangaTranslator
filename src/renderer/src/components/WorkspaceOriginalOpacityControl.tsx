import React from "react";
import { useTranslation } from "react-i18next";
import { clampOriginalImageOpacity } from "../lib/originalImageOpacity";
import { ControlTooltip } from "./ui/ControlTooltip";
import { RangeInput } from "./ui/Field";
import { IconButton } from "./ui/IconButton";
import { usePopupController } from "./ui/usePopupController";

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
  const [open, setOpen] = React.useState(false);
  const { contentRef, rootRef, toggle, triggerRef } = usePopupController({
    disabled: !available,
    initialFocus: ".range-input-control",
    closeOnFocusOut: true,
    open,
    onOpenChange: setOpen,
  });
  // Switching pages resets the panel so it never describes the previous page.
  React.useEffect(() => setOpen(false), [pageId]);
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
    >
      <ControlTooltip
        className="workspace-original-opacity-trigger"
        content={tooltip}
        placement="left"
      >
        <IconButton
          ref={triggerRef}
          variant="dock"
          aria-controls={panelId}
          aria-expanded={open}
          label={open ? labels.hideControl : labels.showControl}
          title=""
          disabled={!available}
          onClick={toggle}
        >
          <OriginalBlendIcon opacity={percentage / 100} />
        </IconButton>
      </ControlTooltip>
      {open ? (
        <div
          ref={contentRef}
          aria-label={labels.label}
          className="workspace-original-opacity-panel"
          id={panelId}
          role="group"
        >
          <label htmlFor={sliderId}>{labels.original}</label>
          <RangeInput
            id={sliderId}
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
