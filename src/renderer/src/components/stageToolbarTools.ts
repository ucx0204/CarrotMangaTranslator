import {
  IconBoxOff,
  IconBrush,
  IconColorPicker,
  IconEraser,
  IconHandStop,
  IconLassoPolygon,
  IconMessageCircle,
  IconOval,
  IconPointer2,
  IconRectangle,
  IconSquarePlus,
  type TablerIcon,
} from "@tabler/icons-react";
import type { RetouchTool, WorkspaceTool } from "../lib/stageTool";
import type { StageToolbarToolEntry } from "./StageToolbarChrome";
import type { StageToolbarGroupId } from "./useStageToolbarFlyout";

export type StageToolbarToolGroup = {
  defaultTool: RetouchTool;
  fallbackIcon: TablerIcon;
  id: StageToolbarGroupId;
  labelKey: string;
  showSwatch?: boolean;
  tools: StageToolbarToolEntry[];
};

const TOOL_ENTRIES: StageToolbarToolEntry[] = [
  toolEntry("select", IconPointer2),
  toolEntry("block", IconSquarePlus),
  toolEntry("hand", IconHandStop),
  toolEntry("bubble", IconMessageCircle),
  toolEntry("mask", IconLassoPolygon),
  toolEntry("brush", IconBrush),
  toolEntry("rectangle", IconRectangle),
  toolEntry("ellipse", IconOval),
  toolEntry("eraser", IconEraser),
  toolEntry("eraser-rectangle", IconBoxOff),
  toolEntry("picker", IconColorPicker),
];

export const STAGE_TOOL_BY_ID = new Map(
  TOOL_ENTRIES.map((entry) => [entry.id, entry] as const),
);
export const STAGE_DIRECT_TOOLS = resolveTools(["select", "block", "hand"]);
export const STAGE_BUBBLE_TOOL = resolveTools([
  "bubble",
])[0] as StageToolbarToolEntry;
export const STAGE_MASK_TOOL = resolveTools([
  "mask",
])[0] as StageToolbarToolEntry;
export const STAGE_TOOL_GROUPS: StageToolbarToolGroup[] = [
  {
    defaultTool: "brush",
    fallbackIcon: IconBrush,
    id: "paint",
    labelKey: "stageToolbar.groups.paint.label",
    showSwatch: true,
    tools: resolveTools(["brush", "rectangle", "ellipse", "picker"]),
  },
  {
    defaultTool: "eraser",
    fallbackIcon: IconEraser,
    id: "restore",
    labelKey: "stageToolbar.groups.restore.label",
    tools: resolveTools(["eraser", "eraser-rectangle"]),
  },
];

export function resolveActiveStageToolInGroup(
  tool: WorkspaceTool,
  regionTranslationActive: boolean,
  group: StageToolbarToolGroup,
): WorkspaceTool | null {
  return !regionTranslationActive &&
    group.tools.some((entry) => entry.id === tool)
    ? tool
    : null;
}

export function resolveSelectedStageToolInGroup(
  group: StageToolbarToolGroup,
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

function toolEntry(id: WorkspaceTool, Icon: TablerIcon): StageToolbarToolEntry {
  return {
    id,
    labelKey: `stageToolbar.tools.${id}.label`,
    titleKey: `stageToolbar.tools.${id}.title`,
    Icon,
  };
}

function resolveTools(ids: WorkspaceTool[]): StageToolbarToolEntry[] {
  return ids.map((id) => {
    const entry = STAGE_TOOL_BY_ID.get(id);
    if (!entry) throw new Error(`Unknown workspace tool: ${id}`);
    return entry;
  });
}
