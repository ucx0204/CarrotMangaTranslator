import React from "react";
import { useTranslation } from "react-i18next";
import {
  IconChevronDown,
  IconTextScan2,
  type TablerIcon,
} from "@tabler/icons-react";
import type { RetouchTool, WorkspaceTool } from "../lib/stageTool";
import {
  CollapsedStageToolbar,
  StageToolButton,
  StageToolbarHideButton,
  ToolbarControl,
} from "./StageToolbarChrome";
import {
  STAGE_BUBBLE_TOOL,
  STAGE_DIRECT_TOOLS,
  STAGE_MASK_TOOL,
  STAGE_TOOL_BY_ID,
  STAGE_TOOL_GROUPS,
  type StageToolbarToolGroup,
} from "./stageToolbarTools";
import { useStageToolbarFlyout } from "./useStageToolbarFlyout";

type StageToolbarProps = {
  bubbleLayoutAvailable?: boolean;
  brushColor: string;
  disabled: boolean;
  hidden: boolean;
  lastRetouchTool: RetouchTool;
  onSelectTool: (tool: WorkspaceTool) => void;
  onToggleRegionTranslation: () => void;
  onToggleHidden: () => void;
  regionTranslationActive: boolean;
  regionTranslationAvailable: boolean;
  tool: WorkspaceTool;
};

type StageToolbarFlyout = ReturnType<typeof useStageToolbarFlyout>;
type StageToolbarFlyoutActions = Omit<StageToolbarFlyout, "rootRef">;
type ToolGroup = StageToolbarToolGroup;

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
  selectedTool: RetouchTool;
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
  | "onSelectTool"
  | "open"
  | "selectedTool"
> & {
  label: string;
  LauncherIcon: TablerIcon;
  menuId: string;
};

/** Compact canvas tool picker with advanced tools grouped into flyouts. */
export function StageToolbar(props: StageToolbarProps): React.JSX.Element {
  const { rootRef, ...flyout } = useStageToolbarFlyout({
    disabled: props.disabled,
    hidden: props.hidden,
  });
  if (props.hidden) {
    return <CollapsedStageToolbar onToggleHidden={props.onToggleHidden} />;
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
    <div
      className="stage-toolbar"
      onBlur={flyout.onToolbarBlur}
      ref={rootRef}
      role="toolbar"
      aria-label={t("stageToolbar.imageTools")}
    >
      <StageToolbarSection name="primary">
        {STAGE_DIRECT_TOOLS.map((entry) => (
          <StageToolButton
            active={!props.regionTranslationActive && props.tool === entry.id}
            disabled={props.disabled}
            entry={entry}
            key={entry.id}
            onSelectTool={props.onSelectTool}
          />
        ))}
      </StageToolbarSection>
      <StageToolbarSection name="layout">
        <RegionTranslationButton {...props} />
        <StageToolButton
          active={!props.regionTranslationActive && props.tool === "bubble"}
          disabled={props.disabled || !props.bubbleLayoutAvailable}
          entry={STAGE_BUBBLE_TOOL}
          onSelectTool={props.onSelectTool}
        />
      </StageToolbarSection>
      <StageToolbarSection name="retouch">
        <StageToolButton
          active={!props.regionTranslationActive && props.tool === "mask"}
          disabled={props.disabled}
          entry={STAGE_MASK_TOOL}
          onSelectTool={props.onSelectTool}
        />
        {STAGE_TOOL_GROUPS.map((group) => {
          const activeTool = resolveActiveGroupTool(props, group);
          return (
            <StageToolGroup
              activeTool={activeTool}
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
              selectedTool={resolveGroupSelectedTool(
                group,
                activeTool,
                props.lastRetouchTool,
              )}
            />
          );
        })}
      </StageToolbarSection>
      <StageToolbarSection name="collapse">
        <StageToolbarHideButton onToggleHidden={props.onToggleHidden} />
      </StageToolbarSection>
    </div>
  );
}

function resolveActiveGroupTool(
  props: StageToolbarProps,
  group: ToolGroup,
): WorkspaceTool | null {
  return !props.regionTranslationActive &&
    group.tools.some((entry) => entry.id === props.tool)
    ? props.tool
    : null;
}

function StageToolbarSection({
  children,
  name,
}: {
  children: React.ReactNode;
  name: "primary" | "layout" | "retouch" | "collapse";
}): React.JSX.Element {
  return (
    <div className="stage-toolbar-section" data-stage-toolbar-section={name}>
      {children}
    </div>
  );
}

function resolveGroupSelectedTool(
  group: ToolGroup,
  activeTool: WorkspaceTool | null,
  lastRetouchTool: RetouchTool,
): RetouchTool {
  if (activeTool && group.tools.some((entry) => entry.id === activeTool)) {
    return activeTool as RetouchTool;
  }
  if (group.tools.some((entry) => entry.id === lastRetouchTool)) {
    return lastRetouchTool;
  }
  return group.defaultTool;
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
  selectedTool,
}: StageToolGroupProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const selectedEntry = STAGE_TOOL_BY_ID.get(selectedTool);
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
        onSelectTool={onSelectTool}
        open={open}
        selectedTool={selectedTool}
      />
      {open ? (
        <StageToolGroupMenu
          disabled={disabled}
          group={group}
          label={t(group.labelKey)}
          menuId={menuId}
          onClose={onClose}
          onKeyDown={onMenuKeyDown}
          onSelectTool={onSelectTool}
          selectedTool={selectedTool}
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
  onSelectTool,
  open,
  selectedTool,
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
      data-selected-tool={selectedTool}
      data-stage-tool-group={group.id}
      disabled={disabled}
      onClick={(event) => {
        onSelectTool(selectedTool);
        onActivate(group.id, event.currentTarget);
      }}
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
      {group.showSwatch ? (
        <i
          aria-hidden="true"
          className="stage-toolbar-swatch"
          data-stage-tool-swatch=""
          style={{ backgroundColor: brushColor }}
        />
      ) : null}
    </button>
  );
}

function StageToolGroupMenu({
  disabled,
  group,
  label,
  menuId,
  onClose,
  onKeyDown,
  onSelectTool,
  selectedTool,
}: {
  disabled: boolean;
  group: (typeof STAGE_TOOL_GROUPS)[number];
  label: string;
  menuId: string;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelectTool: (tool: WorkspaceTool) => void;
  selectedTool: RetouchTool;
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
          active={entry.id === selectedTool}
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
