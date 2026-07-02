import React from "react";
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
  label: string;
  title: string;
  Icon: (props: IconProps) => React.JSX.Element;
}[] = [
  { id: "select", label: "선택", title: "선택 도구 (1)", Icon: CursorIcon },
  {
    id: "block",
    label: "블록",
    title: "블록 도구 (2) — 드래그해서 새 텍스트 블록 추가",
    Icon: BlockPlusIcon,
  },
  {
    id: "hand",
    label: "손바닥",
    title: "손바닥 도구 (3) — 드래그해서 이미지 이동",
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
  if (hidden) {
    return (
      <div className="stage-toolbar collapsed">
        <button
          type="button"
          className="stage-toolbar-toggle"
          title="도구 모음 표시 (4)"
          aria-label="도구 모음 표시"
          onClick={onToggleHidden}
        >
          <ChevronRightIcon size={14} />
        </button>
      </div>
    );
  }
  return (
    <div className="stage-toolbar" role="toolbar" aria-label="이미지 도구">
      {TOOL_BUTTONS.map(({ id, label, title, Icon }) => (
        <button
          key={id}
          type="button"
          className={`stage-toolbar-button ${tool === id ? "active" : ""}`}
          title={title}
          aria-label={label}
          aria-pressed={tool === id}
          onClick={() => onSelectTool(id)}
        >
          <Icon size={16} />
        </button>
      ))}
      <button
        type="button"
        className="stage-toolbar-toggle"
        title="도구 모음 숨기기 (4)"
        aria-label="도구 모음 숨기기"
        onClick={onToggleHidden}
      >
        <ChevronLeftIcon size={14} />
      </button>
    </div>
  );
}
