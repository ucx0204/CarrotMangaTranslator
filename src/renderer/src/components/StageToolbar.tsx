import React from "react";
import { useTranslation } from "react-i18next";
import {
  IconBrush,
  IconChevronDown,
  IconColorPicker,
  IconEraser,
  IconHandStop,
  IconLassoPolygon,
  IconMessageCircle,
  IconOval,
  IconPointer2,
  IconRectangle,
  IconSquarePlus,
  IconTextScan2,
  type TablerIcon,
} from "@tabler/icons-react";
import type { WorkspaceTool } from "../lib/stageTool";
import { StageActiveToolBadge } from "./StageActiveToolBadge";
import {
  CollapsedStageToolbar,
  StageToolButton,
  StageToolbarHideButton,
  ToolbarControl,
  type StageToolbarToolEntry,
} from "./StageToolbarChrome";
import {
  useStageToolbarFlyout,
  type StageToolbarGroupId,
} from "./useStageToolbarFlyout";

type StageToolbarProps = {
  bubbleLayoutAvailable?: boolean;
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

type StageToolbarFlyout = ReturnType<typeof useStageToolbarFlyout>;
type StageToolbarFlyoutActions = Omit<StageToolbarFlyout, "rootRef">;
type ToolEntry = StageToolbarToolEntry;

type ToolGroup = {
  id: StageToolbarGroupId;
  labelKey: string;
  fallbackIcon: TablerIcon;
  tools: ToolEntry[];
};

type StageToolGroupProps = {
  activeTool: WorkspaceTool | null;
  brushColor: string;
  disabled: boolean;
  group: ToolGroup;
  onActivate: StageToolbarFlyout["activate"];
  onCancelScheduledClose: StageToolbarFlyout["cancelScheduledClose"];
  onClose: () => void;
  onMenuKeyDown: StageToolbarFlyout["onMenuKeyDown"];
  onOpenFromPointerOrFocus: StageToolbarFlyout["openFromPointerOrFocus"];
  onSelectTool: (tool: WorkspaceTool) => void;
  onScheduleClose: StageToolbarFlyout["scheduleClose"];
  open: boolean;
};

type StageToolGroupTriggerProps = Pick<
  StageToolGroupProps,
  | "activeTool"
  | "brushColor"
  | "disabled"
  | "group"
  | "onActivate"
  | "onClose"
  | "onOpenFromPointerOrFocus"
  | "open"
> & {
  label: string;
  LauncherIcon: TablerIcon;
  menuId: string;
};

const TOOL_ENTRIES: ToolEntry[] = [
  toolEntry("select", IconPointer2),
  toolEntry("block", IconSquarePlus),
  toolEntry("hand", IconHandStop),
  toolEntry("bubble", IconMessageCircle),
  toolEntry("mask", IconLassoPolygon),
  toolEntry("brush", IconBrush),
  toolEntry("rectangle", IconRectangle),
  toolEntry("ellipse", IconOval),
  toolEntry("eraser", IconEraser),
  toolEntry("picker", IconColorPicker),
];

const TOOL_BY_ID = new Map(
  TOOL_ENTRIES.map((entry) => [entry.id, entry] as const),
);
const DIRECT_TOOLS = resolveTools(["select", "block", "hand"]);
const BUBBLE_TOOL = resolveTools(["bubble"])[0] as ToolEntry;
const TOOL_GROUPS: ToolGroup[] = [
  {
    id: "retouch",
    labelKey: "stageToolbar.groups.retouch.label",
    fallbackIcon: IconBrush,
    tools: resolveTools([
      "mask",
      "brush",
      "rectangle",
      "ellipse",
      "eraser",
      "picker",
    ]),
  },
];

function toolEntry(id: WorkspaceTool, Icon: TablerIcon): ToolEntry {
  return {
    id,
    labelKey: `stageToolbar.tools.${id}.label`,
    titleKey: `stageToolbar.tools.${id}.title`,
    Icon,
  };
}

function resolveTools(ids: WorkspaceTool[]): ToolEntry[] {
  return ids.map((id) => {
    const entry = TOOL_BY_ID.get(id);
    if (!entry) throw new Error(`Unknown workspace tool: ${id}`);
    return entry;
  });
}

/** Compact canvas tool picker with advanced tools grouped into flyouts. */
export function StageToolbar(props: StageToolbarProps): React.JSX.Element {
  const { rootRef, ...flyout } = useStageToolbarFlyout({
    disabled: props.disabled,
    hidden: props.hidden,
  });
  if (props.hidden) {
    return (
      <CollapsedStageToolbar
        brushRadius={props.brushRadius}
        onToggleHidden={props.onToggleHidden}
        tool={props.tool}
      />
    );
  }
  return (
    <ExpandedStageToolbar flyout={flyout} props={props} rootRef={rootRef} />
  );
}

function ExpandedStageToolbar({
  flyout,
  props,
  rootRef,
}: {
  flyout: StageToolbarFlyoutActions;
  props: StageToolbarProps;
  rootRef: StageToolbarFlyout["rootRef"];
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <div
        className="stage-toolbar"
        onBlur={flyout.onToolbarBlur}
        ref={rootRef}
        role="toolbar"
        aria-label={t("stageToolbar.imageTools")}
      >
        {DIRECT_TOOLS.map((entry) => (
          <StageToolButton
            active={!props.regionTranslationActive && props.tool === entry.id}
            disabled={props.disabled}
            entry={entry}
            key={entry.id}
            onSelectTool={props.onSelectTool}
          />
        ))}
        <RegionTranslationButton {...props} />
        <StageToolButton
          active={!props.regionTranslationActive && props.tool === "bubble"}
          disabled={props.disabled || !props.bubbleLayoutAvailable}
          entry={BUBBLE_TOOL}
          onSelectTool={props.onSelectTool}
        />
        {TOOL_GROUPS.map((group) => (
          <StageToolGroup
            activeTool={
              !props.regionTranslationActive &&
              group.tools.some((entry) => entry.id === props.tool)
                ? props.tool
                : null
            }
            brushColor={props.brushColor}
            disabled={props.disabled}
            group={group}
            key={group.id}
            onClose={() => flyout.close(true)}
            onCancelScheduledClose={flyout.cancelScheduledClose}
            onMenuKeyDown={flyout.onMenuKeyDown}
            onOpenFromPointerOrFocus={flyout.openFromPointerOrFocus}
            onSelectTool={props.onSelectTool}
            onActivate={flyout.activate}
            onScheduleClose={flyout.scheduleClose}
            open={flyout.openGroup === group.id}
          />
        ))}
        <StageToolbarHideButton onToggleHidden={props.onToggleHidden} />
      </div>
      <StageActiveToolBadge brushRadius={props.brushRadius} tool={props.tool} />
    </>
  );
}

function RegionTranslationButton(props: StageToolbarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ToolbarControl tooltip={t("stageToolbar.tools.region.title")}>
      <button
        aria-label={t("stageToolbar.tools.region.label")}
        aria-pressed={props.regionTranslationActive}
        className={`stage-toolbar-button ${props.regionTranslationActive ? "active" : ""}`.trim()}
        disabled={props.disabled || !props.regionTranslationAvailable}
        onClick={props.onToggleRegionTranslation}
        type="button"
      >
        <IconTextScan2 size={22} stroke={2.1} aria-hidden="true" />
      </button>
    </ToolbarControl>
  );
}

function StageToolGroup({
  activeTool,
  brushColor,
  disabled,
  group,
  onActivate,
  onCancelScheduledClose,
  onClose,
  onMenuKeyDown,
  onOpenFromPointerOrFocus,
  onSelectTool,
  onScheduleClose,
  open,
}: StageToolGroupProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const selectedEntry = activeTool ? TOOL_BY_ID.get(activeTool) : null;
  const LauncherIcon = selectedEntry?.Icon ?? group.fallbackIcon;
  const menuId = React.useId();
  return (
    <span
      className="stage-toolbar-control stage-toolbar-group-control"
      data-stage-tool-group-control={group.id}
      onPointerEnter={onCancelScheduledClose}
      onPointerLeave={() => onScheduleClose(group.id)}
    >
      <StageToolGroupTrigger
        activeTool={activeTool}
        brushColor={brushColor}
        disabled={disabled}
        group={group}
        label={t(group.labelKey)}
        LauncherIcon={LauncherIcon}
        menuId={menuId}
        onActivate={onActivate}
        onClose={onClose}
        onOpenFromPointerOrFocus={onOpenFromPointerOrFocus}
        open={open}
      />
      {open ? (
        <StageToolGroupMenu
          activeTool={activeTool}
          disabled={disabled}
          group={group}
          label={t(group.labelKey)}
          menuId={menuId}
          onClose={onClose}
          onKeyDown={onMenuKeyDown}
          onSelectTool={onSelectTool}
        />
      ) : null}
    </span>
  );
}

function StageToolGroupTrigger({
  activeTool,
  brushColor,
  disabled,
  group,
  label,
  LauncherIcon,
  menuId,
  onActivate,
  onClose,
  onOpenFromPointerOrFocus,
  open,
}: StageToolGroupTriggerProps): React.JSX.Element {
  const openAndFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      onActivate(group.id, event.currentTarget);
    }
  };
  return (
    <button
      aria-controls={menuId}
      aria-expanded={open}
      aria-haspopup="menu"
      aria-label={label}
      aria-pressed={Boolean(activeTool)}
      className={`stage-toolbar-button stage-toolbar-group-trigger ${activeTool ? "active" : ""}`.trim()}
      data-active-tool={activeTool ?? undefined}
      data-stage-tool-group={group.id}
      disabled={disabled}
      onClick={(event) => onActivate(group.id, event.currentTarget)}
      onFocus={(event) =>
        onOpenFromPointerOrFocus(group.id, event.currentTarget)
      }
      onKeyDown={openAndFocus}
      onPointerEnter={(event) =>
        onOpenFromPointerOrFocus(group.id, event.currentTarget)
      }
      type="button"
    >
      <LauncherIcon size={22} stroke={2.1} aria-hidden="true" />
      <IconChevronDown
        className="stage-toolbar-group-chevron"
        size={10}
        stroke={2.4}
        aria-hidden="true"
      />
      <i
        aria-hidden="true"
        className="stage-toolbar-swatch"
        data-stage-tool-swatch=""
        style={{ backgroundColor: brushColor }}
      />
    </button>
  );
}

function StageToolGroupMenu({
  activeTool,
  disabled,
  group,
  label,
  menuId,
  onClose,
  onKeyDown,
  onSelectTool,
}: {
  activeTool: WorkspaceTool | null;
  disabled: boolean;
  group: (typeof TOOL_GROUPS)[number];
  label: string;
  menuId: string;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelectTool: (tool: WorkspaceTool) => void;
}): React.JSX.Element {
  return (
    <div
      aria-label={label}
      className="stage-toolbar-flyout"
      data-stage-tool-menu={group.id}
      id={menuId}
      onKeyDown={onKeyDown}
      role="menu"
    >
      {group.tools.map((entry) => (
        <StageToolButton
          active={entry.id === activeTool}
          disabled={disabled}
          entry={entry}
          key={entry.id}
          menuItem
          onSelectTool={(tool) => {
            onClose();
            onSelectTool(tool);
          }}
        />
      ))}
    </div>
  );
}
