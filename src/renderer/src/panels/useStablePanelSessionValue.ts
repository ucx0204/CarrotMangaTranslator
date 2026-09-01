import React from "react";
import type { PanelFormatSelection } from "../../../shared/panelBridgeTypes";
import { useEventCallback } from "../hooks/useEventCallback";
import type { PanelSessionValue } from "./panelSession";

type EditingCallbacks = Pick<
  PanelSessionValue,
  | "onAdjustFontSize"
  | "onApplyBlockBackgroundOpacity"
  | "onApplyFormat"
  | "onApplyStylePreset"
  | "onCreateStylePreset"
  | "onDeleteStylePreset"
  | "onDeleteBlock"
  | "onDuplicateBlock"
  | "onEraseBlockOriginal"
  | "onFitBlockBubble"
  | "onRemoveBubbleLayout"
  | "onUpdateBlock"
  | "onUpdateFormat"
>;

type PanelChromeCallbacks = Pick<
  PanelSessionValue,
  | "onBackToPageBlocks"
  | "onDockEditorWindow"
  | "onInsertBlockLibraryEntry"
  | "onOpenBlockLibrary"
  | "onOpenStylePresetManager"
  | "onOverwriteStylePreset"
  | "onPopOutEditor"
  | "onSelectTransformMode"
  | "onStartAreaTranslate"
  | "onToggleEditorFloat"
>;

type PanelSessionCallbacks = EditingCallbacks & PanelChromeCallbacks;

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
  const formatSelection = useStablePanelFormatSelection(value.formatSelection);

  return React.useMemo(
    () => ({
      ...callbacks,
      areaTranslateAvailable: value.areaTranslateAvailable,
      areaTranslateSelecting: value.areaTranslateSelecting,
      blockStylePresets: value.blockStylePresets,
      canCreateStylePreset: value.canCreateStylePreset,
      disableChapterApply: value.disableChapterApply,
      editorDisabled: value.editorDisabled,
      editorFloating: value.editorFloating,
      editorPoppedOut: value.editorPoppedOut,
      editorTextTabRequestToken: value.editorTextTabRequestToken,
      formatSelection,
      selectionKey: value.selectionKey,
      selectedBlock: value.selectedBlock,
      selectedBlockCount: value.selectedBlockCount,
      selectedPageSize,
      showDetachControls: value.showDetachControls,
      transformMode: value.transformMode,
    }),
    [
      callbacks,
      formatSelection,
      selectedPageSize,
      value.areaTranslateAvailable,
      value.areaTranslateSelecting,
      value.blockStylePresets,
      value.canCreateStylePreset,
      value.disableChapterApply,
      value.editorDisabled,
      value.editorFloating,
      value.editorPoppedOut,
      value.editorTextTabRequestToken,
      value.selectionKey,
      value.selectedBlock,
      value.selectedBlockCount,
      value.showDetachControls,
      value.transformMode,
    ],
  );
}

function useStablePanelFormatSelection(
  value: PanelFormatSelection,
): PanelFormatSelection {
  const serialized = JSON.stringify(value);
  return React.useMemo(
    () => JSON.parse(serialized) as PanelFormatSelection,
    [serialized],
  );
}

function useStablePanelSessionCallbacks(
  value: PanelSessionValue,
): PanelSessionCallbacks {
  const editing = useStableEditingCallbacks(value);
  const chrome = useStablePanelChromeCallbacks(value);
  return React.useMemo(() => ({ ...editing, ...chrome }), [chrome, editing]);
}

function useStableEditingCallbacks(value: PanelSessionValue): EditingCallbacks {
  const onAdjustFontSize = useEventCallback(value.onAdjustFontSize);
  const onApplyBlockBackgroundOpacity = useEventCallback(
    value.onApplyBlockBackgroundOpacity,
  );
  const onApplyFormat = useEventCallback(value.onApplyFormat);
  const onApplyStylePreset = useEventCallback(value.onApplyStylePreset);
  const onCreateStylePreset = useEventCallback(value.onCreateStylePreset);
  const onDeleteStylePreset = useEventCallback(value.onDeleteStylePreset);
  const onDeleteBlock = useEventCallback(value.onDeleteBlock);
  const onDuplicateBlock = useEventCallback(value.onDuplicateBlock);
  const onEraseBlockOriginal = useEventCallback(value.onEraseBlockOriginal);
  const onFitBlockBubble = useEventCallback(value.onFitBlockBubble);
  const onRemoveBubbleLayout = useEventCallback(value.onRemoveBubbleLayout);
  const onUpdateBlock = useEventCallback(value.onUpdateBlock);
  const onUpdateFormat = useEventCallback(value.onUpdateFormat);

  return React.useMemo<EditingCallbacks>(
    () => ({
      onAdjustFontSize,
      onApplyBlockBackgroundOpacity,
      onApplyFormat,
      onApplyStylePreset,
      onCreateStylePreset,
      onDeleteStylePreset,
      onDeleteBlock,
      onDuplicateBlock,
      onEraseBlockOriginal,
      onFitBlockBubble,
      onRemoveBubbleLayout,
      onUpdateBlock,
      onUpdateFormat,
    }),
    [
      onAdjustFontSize,
      onApplyBlockBackgroundOpacity,
      onApplyFormat,
      onApplyStylePreset,
      onCreateStylePreset,
      onDeleteStylePreset,
      onDeleteBlock,
      onDuplicateBlock,
      onEraseBlockOriginal,
      onFitBlockBubble,
      onRemoveBubbleLayout,
      onUpdateBlock,
      onUpdateFormat,
    ],
  );
}

function useStablePanelChromeCallbacks(
  value: PanelSessionValue,
): PanelChromeCallbacks {
  const onBackToPageBlocks = useEventCallback(value.onBackToPageBlocks);
  const onDockEditorWindow = useEventCallback(value.onDockEditorWindow);
  const onInsertBlockLibraryEntry = useEventCallback(
    value.onInsertBlockLibraryEntry,
  );
  const onOpenBlockLibrary = useEventCallback(value.onOpenBlockLibrary);
  const onOpenStylePresetManager = useEventCallback(
    value.onOpenStylePresetManager,
  );
  const onOverwriteStylePreset = useEventCallback(value.onOverwriteStylePreset);
  const onPopOutEditor = useEventCallback(value.onPopOutEditor);
  const onSelectTransformMode = useEventCallback(value.onSelectTransformMode);
  const onStartAreaTranslate = useEventCallback(value.onStartAreaTranslate);
  const onToggleEditorFloat = useEventCallback(value.onToggleEditorFloat);

  return React.useMemo<PanelChromeCallbacks>(
    () => ({
      onBackToPageBlocks,
      onDockEditorWindow,
      onInsertBlockLibraryEntry,
      onOpenBlockLibrary,
      onOpenStylePresetManager,
      onOverwriteStylePreset,
      onPopOutEditor,
      onSelectTransformMode,
      onStartAreaTranslate,
      onToggleEditorFloat,
    }),
    [
      onBackToPageBlocks,
      onDockEditorWindow,
      onInsertBlockLibraryEntry,
      onOpenBlockLibrary,
      onOpenStylePresetManager,
      onOverwriteStylePreset,
      onPopOutEditor,
      onSelectTransformMode,
      onStartAreaTranslate,
      onToggleEditorFloat,
    ],
  );
}
