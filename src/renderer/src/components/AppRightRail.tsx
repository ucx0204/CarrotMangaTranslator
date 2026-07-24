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
  | "onCancelJob"
  | "onClearPatternMask"
  | "onOpenAutoInpaintingOptions"
  | "onOpenExport"
  | "onOpenStyleGuide"
  | "onOpenTextView"
  | "onOpenTranslateOptions"
  | "onRunCurrentPageInpainting"
  | "onRunDrawnPattern"
  | "onShowGuide"
  | "onToggleBlocks"
  | "onToggleChrome"
> {
  return {
    onBrushColorChange: useEventCallback(props.onBrushColorChange),
    onBrushRadiusChange: useEventCallback(props.onBrushRadiusChange),
    onCancelJob: useEventCallback(props.onCancelJob),
    onClearPatternMask: useEventCallback(props.onClearPatternMask),
    onOpenAutoInpaintingOptions: useEventCallback(
      props.onOpenAutoInpaintingOptions,
    ),
    onOpenExport: useEventCallback(props.onOpenExport),
    onOpenStyleGuide: useEventCallback(props.onOpenStyleGuide),
    onOpenTextView: useEventCallback(props.onOpenTextView),
    onOpenTranslateOptions: useEventCallback(props.onOpenTranslateOptions),
    onRunCurrentPageInpainting: useEventCallback(
      props.onRunCurrentPageInpainting,
    ),
    onRunDrawnPattern: useEventCallback(props.onRunDrawnPattern),
    onShowGuide: useEventCallback(props.onShowGuide),
    onToggleBlocks: useEventCallback(props.onToggleBlocks),
    onToggleChrome: useEventCallback(props.onToggleChrome),
  };
}
