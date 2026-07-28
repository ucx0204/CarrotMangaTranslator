import React from "react";
import { useEventCallback } from "../hooks/useEventCallback";
import type { PanelSessionValue } from "./panelSession";

type PanelSessionCallbacks = Pick<
  PanelSessionValue,
  | "onAdjustFontSize"
  | "onApplyBlockBackgroundOpacity"
  | "onApplyFormat"
  | "onDeleteBlock"
  | "onDockEditorWindow"
  | "onDuplicateBlock"
  | "onPopOutEditor"
  | "onRemoveBubbleLayout"
  | "onSelectTransformMode"
  | "onStartAreaTranslate"
  | "onToggleEditorFloat"
  | "onUpdateBlock"
>;

export function useStablePanelSessionValue(
  value: PanelSessionValue,
): PanelSessionValue {
  const callbacks = useStablePanelSessionCallbacks(value);
  const pageWidth = value.selectedPageSize?.width;
  const pageHeight = value.selectedPageSize?.height;
  const selectedPageSize = React.useMemo(
    () =>
      pageWidth === undefined || pageHeight === undefined
        ? null
        : { width: pageWidth, height: pageHeight },
    [pageHeight, pageWidth],
  );

  return React.useMemo(
    () => ({
      ...callbacks,
      areaTranslateAvailable: value.areaTranslateAvailable,
      areaTranslateSelecting: value.areaTranslateSelecting,
      disableChapterApply: value.disableChapterApply,
      editorDisabled: value.editorDisabled,
      editorFloating: value.editorFloating,
      editorPoppedOut: value.editorPoppedOut,
      selectedBlock: value.selectedBlock,
      selectedBlockCount: value.selectedBlockCount,
      selectedPageSize,
      showDetachControls: value.showDetachControls,
      transformMode: value.transformMode,
    }),
    [
      callbacks,
      selectedPageSize,
      value.areaTranslateAvailable,
      value.areaTranslateSelecting,
      value.disableChapterApply,
      value.editorDisabled,
      value.editorFloating,
      value.editorPoppedOut,
      value.selectedBlock,
      value.selectedBlockCount,
      value.showDetachControls,
      value.transformMode,
    ],
  );
}

function useStablePanelSessionCallbacks(
  value: PanelSessionValue,
): PanelSessionCallbacks {
  const onAdjustFontSize = useEventCallback(value.onAdjustFontSize);
  const onApplyBlockBackgroundOpacity = useEventCallback(
    value.onApplyBlockBackgroundOpacity,
  );
  const onApplyFormat = useEventCallback(value.onApplyFormat);
  const onDeleteBlock = useEventCallback(value.onDeleteBlock);
  const onDockEditorWindow = useEventCallback(value.onDockEditorWindow);
  const onDuplicateBlock = useEventCallback(value.onDuplicateBlock);
  const onPopOutEditor = useEventCallback(value.onPopOutEditor);
  const onRemoveBubbleLayout = useEventCallback(value.onRemoveBubbleLayout);
  const onSelectTransformMode = useEventCallback(value.onSelectTransformMode);
  const onStartAreaTranslate = useEventCallback(value.onStartAreaTranslate);
  const onToggleEditorFloat = useEventCallback(value.onToggleEditorFloat);
  const onUpdateBlock = useEventCallback(value.onUpdateBlock);

  return React.useMemo<PanelSessionCallbacks>(
    () => ({
      onAdjustFontSize,
      onApplyBlockBackgroundOpacity,
      onApplyFormat,
      onDeleteBlock,
      onDockEditorWindow,
      onDuplicateBlock,
      onPopOutEditor,
      onRemoveBubbleLayout,
      onSelectTransformMode,
      onStartAreaTranslate,
      onToggleEditorFloat,
      onUpdateBlock,
    }),
    [
      onAdjustFontSize,
      onApplyBlockBackgroundOpacity,
      onApplyFormat,
      onDeleteBlock,
      onDockEditorWindow,
      onDuplicateBlock,
      onPopOutEditor,
      onRemoveBubbleLayout,
      onSelectTransformMode,
      onStartAreaTranslate,
      onToggleEditorFloat,
      onUpdateBlock,
    ],
  );
}
