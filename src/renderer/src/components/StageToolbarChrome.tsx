import React from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  type TablerIcon,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { WorkspaceTool } from "../lib/stageTool";
import { StageActiveToolBadge } from "./StageActiveToolBadge";
import { ControlTooltip } from "./ui/ControlTooltip";

export type StageToolbarToolEntry = {
  id: WorkspaceTool;
  labelKey: string;
  titleKey: string;
  Icon: TablerIcon;
};

export function CollapsedStageToolbar({
  brushRadius,
  onToggleHidden,
  tool,
}: {
  brushRadius: number;
  onToggleHidden: () => void;
  tool: WorkspaceTool;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <div className="stage-toolbar collapsed">
        <ToolbarControl tooltip={t("stageToolbar.showTitle")}>
          <button
            aria-label={t("stageToolbar.showTitle")}
            className="stage-toolbar-toggle"
            onClick={onToggleHidden}
            type="button"
          >
            <IconChevronRight size={20} stroke={2.2} aria-hidden="true" />
          </button>
        </ToolbarControl>
      </div>
      <StageActiveToolBadge brushRadius={brushRadius} tool={tool} />
    </>
  );
}

export function ToolbarControl({
  children,
  tooltip,
}: {
  children: React.ReactNode;
  tooltip: string;
}): React.JSX.Element {
  return (
    <ControlTooltip
      className="stage-toolbar-control"
      content={tooltip}
      placement="right"
    >
      {children}
    </ControlTooltip>
  );
}

export function StageToolbarHideButton({
  onToggleHidden,
}: {
  onToggleHidden: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ToolbarControl tooltip={t("stageToolbar.hideTitle")}>
      <button
        aria-label={t("stageToolbar.hideTitle")}
        className="stage-toolbar-toggle"
        onClick={onToggleHidden}
        type="button"
      >
        <IconChevronLeft size={20} stroke={2.2} aria-hidden="true" />
      </button>
    </ToolbarControl>
  );
}

export function StageToolButton({
  active,
  disabled,
  entry: { id, labelKey, titleKey, Icon },
  menuItem = false,
  onSelectTool,
}: {
  active: boolean;
  disabled: boolean;
  entry: StageToolbarToolEntry;
  menuItem?: boolean;
  onSelectTool: (tool: WorkspaceTool) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const button = (
    <button
      aria-checked={menuItem ? active : undefined}
      aria-label={t(labelKey)}
      aria-pressed={menuItem ? undefined : active}
      className={`stage-toolbar-button ${active ? "active" : ""}`.trim()}
      disabled={disabled}
      onClick={() => onSelectTool(id)}
      role={menuItem ? "menuitemradio" : undefined}
      type="button"
    >
      <Icon size={22} stroke={2.1} aria-hidden="true" />
      {menuItem ? (
        <span className="stage-toolbar-flyout-label">{t(labelKey)}</span>
      ) : null}
    </button>
  );
  if (!menuItem) {
    return <ToolbarControl tooltip={t(titleKey)}>{button}</ToolbarControl>;
  }
  return (
    <ControlTooltip
      className="stage-toolbar-flyout-control"
      content={t(titleKey)}
      placement="right"
    >
      {button}
    </ControlTooltip>
  );
}
