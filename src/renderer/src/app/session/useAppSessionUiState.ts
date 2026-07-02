import { useCallback, useMemo, useState } from "react";
import type { InpaintingMaskStroke } from "../../../../shared/inpaintingTypes";
import type { InpaintingTool } from "../../inpainting/inpaintingTypes";
import type { StageTool } from "../../lib/stageTool";
import {
  clampWorkspaceZoom,
  WORKSPACE_ZOOM_STEP,
} from "../../lib/workspaceZoom";

export function useAppSessionUiState() {
  const [inpaintingMode, setInpaintingMode] = useState(false);
  const [inpaintingGuideOpen, setInpaintingGuideOpen] = useState(false);
  const [inpaintingTool, setInpaintingTool] = useState<InpaintingTool>("none");
  const [inpaintingBrushRadius, setInpaintingBrushRadius] = useState(28);
  const [inpaintingPaintColor, setInpaintingPaintColor] = useState("#ffffff");
  const [peekOriginal, setPeekOriginal] = useState(false);
  const [patternMaskStrokesByPage, setPatternMaskStrokesByPage] = useState<
    Record<string, InpaintingMaskStroke[]>
  >({});
  const [showBlockChrome, setShowBlockChrome] = useState(true);
  const [showTextBlocks, setShowTextBlocks] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [textViewOpen, setTextViewOpen] = useState(false);
  const [styleGuideOpen, setStyleGuideOpen] = useState(false);
  const [translateOptionsOpen, setTranslateOptionsOpen] = useState(false);
  const [translationFlowActive, setTranslationFlowActive] = useState(false);
  const [editorFloating, setEditorFloating] = useState(false);
  const [stageTool, setStageTool] = useState<StageTool>("select");
  const [stageToolbarHidden, setStageToolbarHidden] = useState(false);
  const zoom = useWorkspaceZoomControls();

  const toggleEditorFloat = useCallback(
    () => setEditorFloating((floating) => !floating),
    [],
  );

  const resetChapterScopedUi = useCallback(() => {
    setInpaintingMode(false);
    setInpaintingGuideOpen(false);
    setStyleGuideOpen(false);
    setTranslateOptionsOpen(false);
    setPatternMaskStrokesByPage({});
    setStageTool("select");
    zoom.resetWorkspaceZoom();
  }, [zoom]);

  return {
    ...zoom,
    commandPaletteOpen,
    editorFloating,
    inpaintingBrushRadius,
    inpaintingGuideOpen,
    inpaintingMode,
    inpaintingPaintColor,
    inpaintingTool,
    patternMaskStrokesByPage,
    peekOriginal,
    resetChapterScopedUi,
    setCommandPaletteOpen,
    setEditorFloating,
    toggleEditorFloat,
    setInpaintingBrushRadius,
    setInpaintingGuideOpen,
    setInpaintingMode,
    setInpaintingPaintColor,
    setInpaintingTool,
    setPatternMaskStrokesByPage,
    setPeekOriginal,
    setShortcutHelpOpen,
    setShowBlockChrome,
    setShowTextBlocks,
    setStageTool,
    setStageToolbarHidden,
    setStyleGuideOpen,
    setTextViewOpen,
    setTranslateOptionsOpen,
    setTranslationFlowActive,
    shortcutHelpOpen,
    showBlockChrome,
    showTextBlocks,
    stageTool,
    stageToolbarHidden,
    styleGuideOpen,
    textViewOpen,
    translateOptionsOpen,
    translationFlowActive,
  };
}

function useWorkspaceZoomControls() {
  const [workspaceZoom, setWorkspaceZoom] = useState(1);
  const zoomInWorkspace = useCallback(
    () =>
      setWorkspaceZoom((zoom) =>
        clampWorkspaceZoom(zoom + WORKSPACE_ZOOM_STEP),
      ),
    [],
  );
  const zoomOutWorkspace = useCallback(
    () =>
      setWorkspaceZoom((zoom) =>
        clampWorkspaceZoom(zoom - WORKSPACE_ZOOM_STEP),
      ),
    [],
  );
  const resetWorkspaceZoom = useCallback(() => setWorkspaceZoom(1), []);
  return useMemo(
    () => ({
      workspaceZoom,
      zoomInWorkspace,
      zoomOutWorkspace,
      resetWorkspaceZoom,
    }),
    [workspaceZoom, zoomInWorkspace, zoomOutWorkspace, resetWorkspaceZoom],
  );
}
