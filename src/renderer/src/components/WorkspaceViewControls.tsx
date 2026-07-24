import React from "react";
import {
  IconAdjustmentsHorizontal,
  IconAspectRatio,
  IconChevronDown,
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

type WorkspaceViewControlsProps = {
  fitMode: WorkspaceFitMode;
  zoom: number;
  onChangeFitMode: (fitMode: WorkspaceFitMode) => void;
  onResetZoom: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
};

const FIT_MODES: WorkspaceFitMode[] = ["contain", "width", "height", "actual"];

type WorkspaceViewLabels = {
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
  const controls = useCollapsibleViewControls();
  const panelId = React.useId();
  const zoomPercent = Math.round(props.zoom * 100);
  return (
    <div
      className={`workspace-view-dock ${controls.collapsed ? "collapsed" : ""}`.trim()}
    >
      <CollapsedViewTrigger
        buttonRef={controls.revealButtonRef}
        hidden={!controls.collapsed}
        labels={labels}
        panelId={panelId}
        zoomPercent={zoomPercent}
        onExpand={controls.expand}
      />
      <WorkspaceViewPanel
        {...props}
        collapseButtonRef={controls.collapseButtonRef}
        hidden={controls.collapsed}
        labels={labels}
        panelId={panelId}
        zoomPercent={zoomPercent}
        onCollapse={controls.collapse}
      />
    </div>
  );
}

function useCollapsibleViewControls(): {
  collapse: () => void;
  collapseButtonRef: React.RefObject<HTMLButtonElement | null>;
  collapsed: boolean;
  expand: () => void;
  revealButtonRef: React.RefObject<HTMLButtonElement | null>;
} {
  const [collapsed, setCollapsed] = React.useState(false);
  const collapseButtonRef = React.useRef<HTMLButtonElement>(null);
  const revealButtonRef = React.useRef<HTMLButtonElement>(null);
  const focusAfterToggleRef = React.useRef(false);
  const setCollapsedFromControl = React.useCallback(
    (nextCollapsed: boolean) => {
      focusAfterToggleRef.current = true;
      setCollapsed(nextCollapsed);
    },
    [],
  );
  const collapse = React.useCallback(() => {
    setCollapsedFromControl(true);
  }, [setCollapsedFromControl]);
  const expand = React.useCallback(() => {
    setCollapsedFromControl(false);
  }, [setCollapsedFromControl]);
  React.useLayoutEffect(() => {
    if (!focusAfterToggleRef.current) return;
    focusAfterToggleRef.current = false;
    (collapsed ? revealButtonRef : collapseButtonRef).current?.focus();
  }, [collapsed]);
  return {
    collapse,
    collapseButtonRef,
    collapsed,
    expand,
    revealButtonRef,
  };
}

function CollapsedViewTrigger({
  buttonRef,
  hidden,
  labels,
  panelId,
  zoomPercent,
  onExpand,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  hidden: boolean;
  labels: WorkspaceViewLabels;
  panelId: string;
  zoomPercent: number;
  onExpand: () => void;
}): React.JSX.Element {
  return (
    <span className="workspace-view-reveal-slot" hidden={hidden}>
      <ControlTooltip
        className="workspace-view-reveal"
        content={labels.showControls}
        placement="left"
      >
        <button
          type="button"
          ref={buttonRef}
          aria-controls={panelId}
          aria-expanded={false}
          aria-label={labels.showControls}
          onClick={onExpand}
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
  collapseButtonRef,
  hidden,
  labels,
  panelId,
  zoomPercent,
  onCollapse,
  ...props
}: WorkspaceViewControlsProps & {
  collapseButtonRef: React.RefObject<HTMLButtonElement | null>;
  hidden: boolean;
  labels: WorkspaceViewLabels;
  panelId: string;
  zoomPercent: number;
  onCollapse: () => void;
}): React.JSX.Element {
  return (
    <nav
      className="workspace-view-controls"
      aria-label={labels.label}
      hidden={hidden}
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
        onChangeFitMode={props.onChangeFitMode}
      />
      <ControlTooltip
        className="workspace-view-control workspace-view-collapse"
        content={labels.hideControls}
        placement="left"
      >
        <button
          type="button"
          ref={collapseButtonRef}
          aria-controls={panelId}
          aria-expanded={true}
          aria-label={labels.hideControls}
          onClick={onCollapse}
        >
          <IconChevronDown size={18} stroke={2.2} aria-hidden="true" />
        </button>
      </ControlTooltip>
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
        placement="left"
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
        placement="left"
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
        placement="left"
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
  onChangeFitMode,
}: Pick<WorkspaceViewControlsProps, "fitMode" | "onChangeFitMode"> & {
  labels: WorkspaceViewLabels;
}): React.JSX.Element {
  const selectedLabel = labels.fitModes[fitMode];
  return (
    <ControlTooltip
      className="workspace-view-control workspace-fit-picker"
      content={`${labels.fitMode}: ${selectedLabel}`}
      placement="left"
    >
      <span className="workspace-fit-picker-face" aria-hidden="true">
        <IconAspectRatio size={19} stroke={2} />
      </span>
      <select
        aria-label={labels.fitMode}
        value={fitMode}
        onChange={(event) =>
          onChangeFitMode(event.target.value as WorkspaceFitMode)
        }
      >
        {FIT_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {labels.fitModes[mode]}
          </option>
        ))}
      </select>
    </ControlTooltip>
  );
}

function useWorkspaceViewLabels(): WorkspaceViewLabels {
  const { t } = useTranslation("components");
  return React.useMemo(
    () => ({
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
