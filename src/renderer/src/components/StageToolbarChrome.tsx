import React from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  type TablerIcon,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { WorkspaceTool } from "../lib/stageTool";
import { ControlTooltip } from "./ui/ControlTooltip";
import { IconButton } from "./ui/IconButton";

export type StageToolbarToolEntry = {
  id: WorkspaceTool;
  labelKey: string;
  titleKey: string;
  Icon: TablerIcon;
};

export function CollapsedStageToolbar({
  onToggleHidden,
}: {
  onToggleHidden: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="stage-toolbar collapsed">
      <ToolbarControl tooltip={t("stageToolbar.showTitle")}>
        <IconButton
          variant="canvas"
          size="lg"
          className="stage-toolbar-toggle"
          label={t("stageToolbar.showTitle")}
          title=""
          onClick={onToggleHidden}
        >
          <IconChevronRight size={20} stroke={2.2} aria-hidden="true" />
        </IconButton>
      </ToolbarControl>
    </div>
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
      <IconButton
        variant="canvas"
        size="lg"
        className="stage-toolbar-toggle"
        label={t("stageToolbar.hideTitle")}
        title=""
        onClick={onToggleHidden}
      >
        <IconChevronLeft size={20} stroke={2.2} aria-hidden="true" />
      </IconButton>
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
    <IconButton
      variant="canvas"
      size="lg"
      aria-checked={menuItem ? active : undefined}
      label={t(labelKey)}
      title=""
      aria-pressed={menuItem ? undefined : active}
      disabled={disabled}
      onClick={() => onSelectTool(id)}
      role={menuItem ? "menuitemradio" : undefined}
    >
      <Icon size={22} stroke={2.1} aria-hidden="true" />
      {menuItem ? (
        <span className="stage-toolbar-flyout-label">{t(labelKey)}</span>
      ) : null}
    </IconButton>
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
