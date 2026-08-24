import React from "react";
import {
  UnifiedRightRail,
  type UnifiedRightRailProps,
} from "./rightRailPanels";
import { useEventCallback } from "../hooks/useEventCallback";

type AppRightRailProps = UnifiedRightRailProps;

// The text-block editor is rendered by EditorPanelContainer, which reads the
// selected block and edit actions from the panel session context rather than
// from these rail props.
export function AppRightRail(props: AppRightRailProps): React.JSX.Element {
  const stableActions = useStableRightRailActions(props);
  return (
    <aside className="right-rail">
      <UnifiedRightRail {...props} {...stableActions} />
    </aside>
  );
}

function useStableRightRailActions(
  props: AppRightRailProps,
): Pick<
  AppRightRailProps,
  | "onBrushColorChange"
  | "onBrushRadiusChange"
  | "onAdjustPatternMask"
  | "onCancelJob"
  | "onClearStatusLines"
  | "onClearPatternMask"
  | "onChangeBlockSelection"
  | "onOpenBlockEditor"
  | "onOpenAutoInpaintingOptions"
  | "onOpenExport"
  | "onOpenPsdExport"
  | "onViewLinkedResults"
  | "onOpenStyleGuide"
  | "onOpenTextView"
  | "onOpenTranslateOptions"
  | "onMoveBlockInReadingOrder"
  | "onPeekToggle"
  | "onRedo"
  | "onResetPage"
  | "onRunBubbleLayout"
  | "onRunDrawnPattern"
  | "onSelectBlock"
  | "onSortReadingOrder"
  | "onToggleBlocks"
  | "onToggleChrome"
  | "onUndo"
  | "onUpdateBlock"
> {
  return {
    onBrushColorChange: useEventCallback(props.onBrushColorChange),
    onBrushRadiusChange: useEventCallback(props.onBrushRadiusChange),
    onAdjustPatternMask: useEventCallback(
      props.onAdjustPatternMask ?? NOOP_ADJUST_MASK,
    ),
    onCancelJob: useEventCallback(props.onCancelJob),
    onClearStatusLines: useEventCallback(props.onClearStatusLines),
    onClearPatternMask: useEventCallback(props.onClearPatternMask),
    onChangeBlockSelection: useEventCallback(
      props.onChangeBlockSelection ?? NOOP_SELECTION_CHANGE,
    ),
    onOpenBlockEditor: useEventCallback(props.onOpenBlockEditor),
    onOpenAutoInpaintingOptions: useEventCallback(
      props.onOpenAutoInpaintingOptions,
    ),
    onOpenExport: useEventCallback(props.onOpenExport),
    onOpenPsdExport: useEventCallback(props.onOpenPsdExport ?? NOOP),
    onViewLinkedResults: useEventCallback(props.onViewLinkedResults ?? NOOP),
    onOpenStyleGuide: useEventCallback(props.onOpenStyleGuide),
    onOpenTextView: useEventCallback(props.onOpenTextView),
    onOpenTranslateOptions: useEventCallback(props.onOpenTranslateOptions),
    onMoveBlockInReadingOrder: useEventCallback(
      props.onMoveBlockInReadingOrder ?? NOOP_MOVE_BLOCK,
    ),
    onPeekToggle: useEventCallback(props.onPeekToggle),
    onRedo: useEventCallback(props.onRedo),
    onResetPage: useEventCallback(props.onResetPage),
    onRunBubbleLayout: useEventCallback(props.onRunBubbleLayout),
    onRunDrawnPattern: useEventCallback(props.onRunDrawnPattern),
    onSelectBlock: useEventCallback(props.onSelectBlock),
    onSortReadingOrder: useEventCallback(props.onSortReadingOrder ?? NOOP),
    onToggleBlocks: useEventCallback(props.onToggleBlocks),
    onToggleChrome: useEventCallback(props.onToggleChrome),
    onUndo: useEventCallback(props.onUndo),
    onUpdateBlock: useEventCallback(props.onUpdateBlock),
  };
}

const NOOP = (): void => undefined;
const NOOP_ADJUST_MASK = (): void => undefined;
const NOOP_MOVE_BLOCK = (): void => undefined;
const NOOP_SELECTION_CHANGE = (): void => undefined;
