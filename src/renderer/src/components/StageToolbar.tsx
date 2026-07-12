import React from "react";
import { useTranslation } from "react-i18next";
import type { StageTool } from "../lib/stageTool";
import {
  BlockPlusIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CursorIcon,
  HandIcon,
  type IconProps,
} from "./ui";

type StageToolbarProps = {
  hidden: boolean;
  onSelectTool: (tool: StageTool) => void;
  onToggleHidden: () => void;
  tool: StageTool;
};

const TOOL_BUTTONS: {
  id: StageTool;
  labelKey: string;
  titleKey: string;
  Icon: (props: IconProps) => React.JSX.Element;
}[] = [
  {
    id: "select",
    labelKey: "stageToolbar.tools.select.label",
    titleKey: "stageToolbar.tools.select.title",
    Icon: CursorIcon,
  },
  {
    id: "block",
    labelKey: "stageToolbar.tools.block.label",
    titleKey: "stageToolbar.tools.block.title",
    Icon: BlockPlusIcon,
  },
  {
    id: "hand",
    labelKey: "stageToolbar.tools.hand.label",
    titleKey: "stageToolbar.tools.hand.title",
    Icon: HandIcon,
  },
];

/**
 * Small vertical tool strip docked at the left edge of the workspace
 * (select / block / hand), with a collapse toggle underneath.
 */
export function StageToolbar({
  hidden,
  onSelectTool,
  onToggleHidden,
  tool,
}: StageToolbarProps): React.JSX.Element {
  const { t } = useTranslation("components");
  if (hidden) {
    return (
      <div className="stage-toolbar collapsed">
        <button
          type="button"
          className="stage-toolbar-toggle"
          title={t("stageToolbar.showTitle")}
          aria-label={t("stageToolbar.show")}
          onClick={onToggleHidden}
        >
          <ChevronRightIcon size={14} />
        </button>
      </div>
    );
  }
  return (
    <div
      className="stage-toolbar"
      role="toolbar"
      aria-label={t("stageToolbar.imageTools")}
    >
      {TOOL_BUTTONS.map(({ id, labelKey, titleKey, Icon }) => (
        <button
          key={id}
          type="button"
          className={`stage-toolbar-button ${tool === id ? "active" : ""}`}
          title={t(titleKey)}
          aria-label={t(labelKey)}
          aria-pressed={tool === id}
          onClick={() => onSelectTool(id)}
        >
          <Icon size={16} />
        </button>
      ))}
      <button
        type="button"
        className="stage-toolbar-toggle"
        title={t("stageToolbar.hideTitle")}
        aria-label={t("stageToolbar.hide")}
        onClick={onToggleHidden}
      >
        <ChevronLeftIcon size={14} />
      </button>
    </div>
  );
}
