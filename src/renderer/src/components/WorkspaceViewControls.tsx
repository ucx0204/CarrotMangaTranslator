import React from "react";
import { IconMinus, IconPlus } from "@tabler/icons-react";
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

/** Compact view controls anchored inside the image workspace. */
export function WorkspaceViewControls({
  fitMode,
  zoom,
  onChangeFitMode,
  onResetZoom,
  onZoomIn,
  onZoomOut,
}: WorkspaceViewControlsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const zoomPercent = Math.round(zoom * 100);
  return (
    <nav
      className="workspace-view-controls"
      aria-label={t("workspace.view.label")}
    >
      <ControlTooltip
        className="workspace-view-control"
        content={t("workspace.view.zoomOut")}
        placement="top"
      >
        <button
          type="button"
          aria-label={t("workspace.view.zoomOut")}
          disabled={zoom <= MIN_WORKSPACE_ZOOM}
          onClick={onZoomOut}
        >
          <IconMinus size={18} stroke={2.2} aria-hidden="true" />
        </button>
      </ControlTooltip>
      <ControlTooltip
        className="workspace-view-control workspace-zoom-percent"
        content={t("workspace.view.resetZoom")}
        placement="top"
      >
        <button
          type="button"
          aria-label={t("workspace.view.resetZoom")}
          onClick={onResetZoom}
        >
          {zoomPercent}%
        </button>
      </ControlTooltip>
      <ControlTooltip
        className="workspace-view-control"
        content={t("workspace.view.zoomIn")}
        placement="top"
      >
        <button
          type="button"
          aria-label={t("workspace.view.zoomIn")}
          disabled={zoom >= MAX_WORKSPACE_ZOOM}
          onClick={onZoomIn}
        >
          <IconPlus size={18} stroke={2.2} aria-hidden="true" />
        </button>
      </ControlTooltip>
      <div className="workspace-view-separator" aria-hidden="true" />
      <select
        className="workspace-fit-select"
        aria-label={t("workspace.view.fitMode")}
        value={fitMode}
        onChange={(event) =>
          onChangeFitMode(event.target.value as WorkspaceFitMode)
        }
      >
        {FIT_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {t(`workspace.view.${mode}`)}
          </option>
        ))}
      </select>
    </nav>
  );
}
