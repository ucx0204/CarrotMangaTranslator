import React from "react";
import {
  IconAdjustmentsHorizontal,
  IconAspectRatio,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import {
  MAX_WORKSPACE_ZOOM,
  MIN_WORKSPACE_ZOOM,
  type WorkspaceFitMode,
} from "../lib/workspaceZoom";
import { ControlTooltip } from "./ui/ControlTooltip";
import { Select } from "./ui/Select";

export type WorkspaceViewControlsProps = {
  effectiveScale: number;
  fitMode: WorkspaceFitMode;
  zoom: number;
  onChangeFitMode: (fitMode: WorkspaceFitMode) => void;
  onResetZoom: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
};

const FIT_MODES: WorkspaceFitMode[] = ["contain", "width", "height", "actual"];

type WorkspaceViewLabels = {
  adjusted: string;
  fitMode: string;
  fitModes: Record<WorkspaceFitMode, string>;
  hideControls: string;
  label: string;
  resetZoom: string;
  showControls: string;
  zoomIn: string;
  zoomOut: string;
};

/** Compact view controls anchored inside the image workspace. */
export function WorkspaceViewControls(
  props: WorkspaceViewControlsProps,
): React.JSX.Element {
  const labels = useWorkspaceViewLabels();
  const { open, rootRef, toggle, triggerRef } = useWorkspaceViewPopup();
  const panelId = React.useId();
  const zoomPercent = Math.round(props.effectiveScale * 100);
  return (
    <div
      ref={rootRef}
      className={`workspace-view-dock ${open ? "open" : ""}`.trim()}
    >
      <WorkspaceViewTrigger
        buttonRef={triggerRef}
        labels={labels}
        open={open}
        panelId={panelId}
        zoomPercent={zoomPercent}
        onToggle={toggle}
      />
      {open ? (
        <WorkspaceViewPanel
          {...props}
          labels={labels}
          panelId={panelId}
          zoomPercent={zoomPercent}
        />
      ) : null}
    </div>
  );
}

function useWorkspaceViewPopup(): {
  open: boolean;
  rootRef: React.RefObject<HTMLDivElement | null>;
  toggle: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
} {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    const handlePointerDown = (event: PointerEvent): void => {
      if (!isWorkspaceViewPopupTarget(rootRef.current, event.target)) close();
    };
    const handleFocusIn = (event: FocusEvent): void => {
      if (!isWorkspaceViewPopupTarget(rootRef.current, event.target)) close();
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
    toggle: React.useCallback(() => setOpen((current) => !current), []),
    triggerRef,
  };
}

function isWorkspaceViewPopupTarget(
  root: HTMLDivElement | null,
  target: EventTarget | null,
): boolean {
  if (!root || !(target instanceof Node)) return false;
  if (root.contains(target)) return true;
  const targetElement =
    target instanceof Element ? target : target.parentElement;
  const selectMenu = targetElement?.closest<HTMLElement>(
    "[data-ui-select-menu]",
  );
  if (!selectMenu) return false;
  const controlledListboxId = root
    .querySelector<HTMLElement>("[data-ui-select-trigger][aria-controls]")
    ?.getAttribute("aria-controls");
  const controlledListbox = controlledListboxId
    ? document.getElementById(controlledListboxId)
    : null;
  return Boolean(controlledListbox && selectMenu.contains(controlledListbox));
}

function WorkspaceViewTrigger({
  buttonRef,
  labels,
  open,
  panelId,
  zoomPercent,
  onToggle,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  labels: WorkspaceViewLabels;
  open: boolean;
  panelId: string;
  zoomPercent: number;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <span className="workspace-view-reveal-slot">
      <ControlTooltip
        className="workspace-view-reveal"
        content={open ? labels.hideControls : labels.showControls}
        placement="left"
      >
        <button
          type="button"
          ref={buttonRef}
          aria-controls={panelId}
          aria-expanded={open}
          aria-label={open ? labels.hideControls : labels.showControls}
          onClick={onToggle}
        >
          <IconAdjustmentsHorizontal
            size={16}
            stroke={2.1}
            aria-hidden="true"
          />
          <span>{zoomPercent}%</span>
        </button>
      </ControlTooltip>
    </span>
  );
}

function WorkspaceViewPanel({
  labels,
  panelId,
  zoomPercent,
  ...props
}: WorkspaceViewControlsProps & {
  labels: WorkspaceViewLabels;
  panelId: string;
  zoomPercent: number;
}): React.JSX.Element {
  return (
    <nav
      className="workspace-view-controls"
      aria-label={labels.label}
      id={panelId}
    >
      <WorkspaceZoomRow
        labels={labels}
        zoom={props.zoom}
        zoomPercent={zoomPercent}
        onResetZoom={props.onResetZoom}
        onZoomIn={props.onZoomIn}
        onZoomOut={props.onZoomOut}
      />
      <WorkspaceFitModeSelect
        fitMode={props.fitMode}
        labels={labels}
        zoom={props.zoom}
        zoomPercent={zoomPercent}
        onChangeFitMode={props.onChangeFitMode}
      />
    </nav>
  );
}

function WorkspaceZoomRow({
  labels,
  zoom,
  zoomPercent,
  onResetZoom,
  onZoomIn,
  onZoomOut,
}: Pick<
  WorkspaceViewControlsProps,
  "zoom" | "onResetZoom" | "onZoomIn" | "onZoomOut"
> & {
  labels: WorkspaceViewLabels;
  zoomPercent: number;
}): React.JSX.Element {
  return (
    <div className="workspace-view-zoom-row">
      <ControlTooltip
        className="workspace-view-control"
        content={labels.zoomIn}
        placement="bottom"
      >
        <button
          type="button"
          aria-label={labels.zoomIn}
          disabled={zoom >= MAX_WORKSPACE_ZOOM}
          onClick={onZoomIn}
        >
          <IconPlus size={18} stroke={2.2} aria-hidden="true" />
        </button>
      </ControlTooltip>
      <ControlTooltip
        className="workspace-view-control workspace-zoom-percent"
        content={labels.resetZoom}
        placement="bottom"
      >
        <button
          type="button"
          aria-label={labels.resetZoom}
          onClick={onResetZoom}
        >
          {zoomPercent}%
        </button>
      </ControlTooltip>
      <ControlTooltip
        className="workspace-view-control"
        content={labels.zoomOut}
        placement="bottom"
      >
        <button
          type="button"
          aria-label={labels.zoomOut}
          disabled={zoom <= MIN_WORKSPACE_ZOOM}
          onClick={onZoomOut}
        >
          <IconMinus size={18} stroke={2.2} aria-hidden="true" />
        </button>
      </ControlTooltip>
    </div>
  );
}

function WorkspaceFitModeSelect({
  fitMode,
  labels,
  zoom,
  zoomPercent,
  onChangeFitMode,
}: Pick<WorkspaceViewControlsProps, "fitMode" | "zoom" | "onChangeFitMode"> & {
  labels: WorkspaceViewLabels;
  zoomPercent: number;
}): React.JSX.Element {
  const adjusted = Math.abs(zoom - 1) > 0.001;
  const selectedLabel = adjusted
    ? `${labels.adjusted} (${zoomPercent}%)`
    : labels.fitModes[fitMode];
  return (
    <ControlTooltip
      className="workspace-view-control workspace-fit-picker"
      content={`${labels.fitMode}: ${selectedLabel}`}
      placement="bottom"
    >
      <span className="workspace-fit-picker-face" aria-hidden="true">
        <IconAspectRatio size={19} stroke={2} />
      </span>
      <Select
        ariaLabel={labels.fitMode}
        className="workspace-fit-select"
        placeholder={selectedLabel}
        value={adjusted ? "__adjusted__" : fitMode}
        options={FIT_MODES.map((mode) => ({
          value: mode,
          label: labels.fitModes[mode],
        }))}
        onValueChange={(nextValue) =>
          onChangeFitMode(nextValue as WorkspaceFitMode)
        }
      />
    </ControlTooltip>
  );
}

function useWorkspaceViewLabels(): WorkspaceViewLabels {
  const { t } = useTranslation("components");
  return React.useMemo(
    () => ({
      adjusted: t("workspace.view.adjusted"),
      fitMode: t("workspace.view.fitMode"),
      fitModes: {
        actual: t("workspace.view.actual"),
        contain: t("workspace.view.contain"),
        height: t("workspace.view.height"),
        width: t("workspace.view.width"),
      },
      hideControls: t("workspace.view.hideControls"),
      label: t("workspace.view.label"),
      resetZoom: t("workspace.view.resetZoom"),
      showControls: t("workspace.view.showControls"),
      zoomIn: t("workspace.view.zoomIn"),
      zoomOut: t("workspace.view.zoomOut"),
    }),
    [t],
  );
}
