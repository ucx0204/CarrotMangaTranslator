import React from "react";
import { useTranslation } from "react-i18next";
import {
  IconBrush,
  IconChevronLeft,
  IconChevronRight,
  IconColorPicker,
  IconEraser,
  IconHandStop,
  IconLassoPolygon,
  IconPointer2,
  IconSquarePlus,
  IconTextScan2,
  type TablerIcon,
} from "@tabler/icons-react";
import {
  isRetouchTool,
  isSizableRetouchTool,
  type WorkspaceTool,
} from "../lib/stageTool";
import { ControlTooltip } from "./ui/ControlTooltip";

type StageToolbarProps = {
  brushColor: string;
  brushRadius: number;
  disabled: boolean;
  hidden: boolean;
  onSelectTool: (tool: WorkspaceTool) => void;
  onToggleRegionTranslation: () => void;
  onToggleHidden: () => void;
  regionTranslationActive: boolean;
  regionTranslationAvailable: boolean;
  tool: WorkspaceTool;
};

const TOOL_BUTTONS: {
  id: WorkspaceTool;
  labelKey: string;
  titleKey: string;
  Icon: TablerIcon;
  separated?: boolean;
}[] = [
  {
    id: "select",
    labelKey: "stageToolbar.tools.select.label",
    titleKey: "stageToolbar.tools.select.title",
    Icon: IconPointer2,
  },
  {
    id: "block",
    labelKey: "stageToolbar.tools.block.label",
    titleKey: "stageToolbar.tools.block.title",
    Icon: IconSquarePlus,
  },
  {
    id: "hand",
    labelKey: "stageToolbar.tools.hand.label",
    titleKey: "stageToolbar.tools.hand.title",
    Icon: IconHandStop,
  },
  {
    id: "mask",
    labelKey: "stageToolbar.tools.mask.label",
    titleKey: "stageToolbar.tools.mask.title",
    Icon: IconLassoPolygon,
    separated: true,
  },
  {
    id: "brush",
    labelKey: "stageToolbar.tools.brush.label",
    titleKey: "stageToolbar.tools.brush.title",
    Icon: IconBrush,
  },
  {
    id: "eraser",
    labelKey: "stageToolbar.tools.eraser.label",
    titleKey: "stageToolbar.tools.eraser.title",
    Icon: IconEraser,
  },
  {
    id: "picker",
    labelKey: "stageToolbar.tools.picker.label",
    titleKey: "stageToolbar.tools.picker.title",
    Icon: IconColorPicker,
  },
];

/**
 * Small vertical tool strip docked at the left edge of the workspace
 * with a collapse toggle underneath. Translation and retouch tools share the
 * same active state so pointer gestures cannot accidentally overlap.
 */
export function StageToolbar({
  brushColor,
  brushRadius,
  disabled,
  hidden,
  onSelectTool,
  onToggleRegionTranslation,
  onToggleHidden,
  regionTranslationActive,
  regionTranslationAvailable,
  tool,
}: StageToolbarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  if (hidden) {
    return (
      <CollapsedStageToolbar
        brushRadius={brushRadius}
        onToggleHidden={onToggleHidden}
        tool={tool}
      />
    );
  }
  return (
    <>
      <div
        className="stage-toolbar"
        role="toolbar"
        aria-label={t("stageToolbar.imageTools")}
      >
        {TOOL_BUTTONS.slice(0, 2).map((entry) => (
          <StageToolButton
            key={entry.id}
            active={!regionTranslationActive && tool === entry.id}
            brushColor={brushColor}
            disabled={disabled}
            entry={entry}
            onSelectTool={onSelectTool}
          />
        ))}
        <ToolbarControl tooltip={t("stageToolbar.tools.region.title")}>
          <button
            type="button"
            className={`stage-toolbar-button ${regionTranslationActive ? "active" : ""}`.trim()}
            aria-label={t("stageToolbar.tools.region.label")}
            aria-pressed={regionTranslationActive}
            disabled={disabled || !regionTranslationAvailable}
            onClick={onToggleRegionTranslation}
          >
            <IconTextScan2 size={22} stroke={2.1} aria-hidden="true" />
          </button>
        </ToolbarControl>
        {TOOL_BUTTONS.slice(2).map((entry) => (
          <StageToolButton
            key={entry.id}
            active={!regionTranslationActive && tool === entry.id}
            brushColor={brushColor}
            disabled={disabled}
            entry={entry}
            onSelectTool={onSelectTool}
          />
        ))}
        <ToolbarControl tooltip={t("stageToolbar.hideTitle")}>
          <button
            type="button"
            className="stage-toolbar-toggle"
            aria-label={t("stageToolbar.hideTitle")}
            onClick={onToggleHidden}
          >
            <IconChevronLeft size={20} stroke={2.2} aria-hidden="true" />
          </button>
        </ToolbarControl>
      </div>
      <ActiveToolBadge brushRadius={brushRadius} tool={tool} />
    </>
  );
}

function CollapsedStageToolbar({
  brushRadius,
  onToggleHidden,
  tool,
}: Pick<
  StageToolbarProps,
  "brushRadius" | "onToggleHidden" | "tool"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <div className="stage-toolbar collapsed">
        <ToolbarControl tooltip={t("stageToolbar.showTitle")}>
          <button
            type="button"
            className="stage-toolbar-toggle"
            aria-label={t("stageToolbar.showTitle")}
            onClick={onToggleHidden}
          >
            <IconChevronRight size={20} stroke={2.2} aria-hidden="true" />
          </button>
        </ToolbarControl>
      </div>
      <ActiveToolBadge brushRadius={brushRadius} tool={tool} />
    </>
  );
}

function StageToolButton({
  active,
  brushColor,
  disabled,
  entry: { id, labelKey, titleKey, Icon, separated },
  onSelectTool,
}: {
  active: boolean;
  brushColor: string;
  disabled: boolean;
  entry: (typeof TOOL_BUTTONS)[number];
  onSelectTool: (tool: WorkspaceTool) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ToolbarControl separated={separated} tooltip={t(titleKey)}>
      <button
        type="button"
        className={`stage-toolbar-button ${active ? "active" : ""}`.trim()}
        aria-label={t(labelKey)}
        aria-pressed={active}
        disabled={disabled}
        onClick={() => onSelectTool(id)}
      >
        <Icon size={22} stroke={2.1} aria-hidden="true" />
        {id === "brush" ? (
          <i
            className="stage-toolbar-swatch"
            style={{ backgroundColor: brushColor }}
            aria-hidden="true"
          />
        ) : null}
      </button>
    </ToolbarControl>
  );
}

function ToolbarControl({
  children,
  separated = false,
  tooltip,
}: {
  children: React.ReactNode;
  separated?: boolean;
  tooltip: string;
}): React.JSX.Element {
  return (
    <ControlTooltip
      className={`stage-toolbar-control ${separated ? "separated" : ""}`.trim()}
      content={tooltip}
      placement="right"
    >
      {children}
    </ControlTooltip>
  );
}

function ActiveToolBadge({
  brushRadius,
  tool,
}: Pick<StageToolbarProps, "brushRadius" | "tool">): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (!isRetouchTool(tool)) {
    return null;
  }
  return (
    <div className="stage-active-tool-badge" role="status">
      <span>{t(`stageToolbar.tools.${tool}.label`)}</span>
      {isSizableRetouchTool(tool) ? (
        <>
          <span aria-hidden="true">·</span>
          <strong>{t("stageToolbar.radius", { radius: brushRadius })}</strong>
        </>
      ) : null}
    </div>
  );
}
