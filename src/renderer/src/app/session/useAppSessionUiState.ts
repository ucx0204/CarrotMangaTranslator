import {
  useCallback,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { InpaintingMaskStroke } from "../../../../shared/inpaintingTypes";
import type { InpaintingTool } from "../../inpainting/inpaintingTypes";
import type { StageTool } from "../../lib/stageTool";
import {
  clampWorkspaceZoom,
  WORKSPACE_ZOOM_STEP,
  type WorkspaceFitMode,
} from "../../lib/workspaceZoom";

export function useAppSessionUiState() {
  const inpaintingUi = useInpaintingUiState();
  const { resetInpaintingUi } = inpaintingUi;
  const [showBlockChrome, setShowBlockChrome] = useState(true);
  const [showTextBlocks, setShowTextBlocks] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [textViewOpen, setTextViewOpen] = useState(false);
  const [styleGuideOpen, setStyleGuideOpen] = useState(false);
  const translateModals = useTranslateModalUiState();
  const [translationFlowActive, setTranslationFlowActive] = useState(false);
  const [editorFloating, setEditorFloating] = useState(false);
  const [stageToolbarHidden, setStageToolbarHidden] = useState(false);
  const zoom = useWorkspaceZoomControls();

  const toggleEditorFloat = useCallback(
    () => setEditorFloating((floating) => !floating),
    [],
  );

  const resetChapterScopedUi = useCallback(() => {
    resetInpaintingUi();
    setStyleGuideOpen(false);
    translateModals.resetTranslateModals();
    zoom.resetWorkspaceZoom();
  }, [resetInpaintingUi, translateModals, zoom]);

  return {
    ...zoom,
    ...translateModals,
    ...inpaintingUi,
    commandPaletteOpen,
    editorFloating,
    resetChapterScopedUi,
    setCommandPaletteOpen,
    setEditorFloating,
    toggleEditorFloat,
    setShortcutHelpOpen,
    setShowBlockChrome,
    setShowTextBlocks,
    setStageToolbarHidden,
    setStyleGuideOpen,
    setTextViewOpen,
    setTranslationFlowActive,
    shortcutHelpOpen,
    showBlockChrome,
    showTextBlocks,
    stageToolbarHidden,
    styleGuideOpen,
    textViewOpen,
    translationFlowActive,
  };
}

function useInpaintingUiState() {
  const [inpaintingGuideOpen, setInpaintingGuideOpen] = useState(false);
  const [autoInpaintingOptionsOpen, setAutoInpaintingOptionsOpen] =
    useState(false);
  const [exportOptionsOpen, setExportOptionsOpen] = useState(false);
  const [inpaintingBrushRadius, setInpaintingBrushRadius] = useState(28);
  const [inpaintingPaintColor, setInpaintingPaintColor] = useState("#ffffff");
  const [peekOriginal, setPeekOriginal] = useState(false);
  const [patternMaskStrokesByPage, setPatternMaskStrokesByPage] = useState<
    Record<string, InpaintingMaskStroke[]>
  >({});
  const [stageTool, setStageTool] = useState<StageTool>("select");
  const inpaintingTool = resolveInpaintingTool(stageTool);
  const setInpaintingTool = useInpaintingToolSetter(setStageTool);
  const selectWorkspaceTool = useCallback((tool: StageTool) => {
    setStageTool(tool);
    if (isManualInpaintingTool(tool)) {
      setPeekOriginal(false);
    }
  }, []);
  const resetInpaintingUi = useCallback(() => {
    setAutoInpaintingOptionsOpen(false);
    setExportOptionsOpen(false);
    setInpaintingGuideOpen(false);
    setPatternMaskStrokesByPage({});
    setPeekOriginal(false);
    setStageTool("select");
  }, []);
  return {
    autoInpaintingOptionsOpen,
    exportOptionsOpen,
    inpaintingBrushRadius,
    inpaintingGuideOpen,
    inpaintingPaintColor,
    inpaintingTool,
    patternMaskStrokesByPage,
    peekOriginal,
    resetInpaintingUi,
    selectWorkspaceTool,
    setAutoInpaintingOptionsOpen,
    setExportOptionsOpen,
    setInpaintingBrushRadius,
    setInpaintingGuideOpen,
    setInpaintingPaintColor,
    setInpaintingTool,
    setPatternMaskStrokesByPage,
    setPeekOriginal,
    setStageTool,
    stageTool,
  };
}

function useInpaintingToolSetter(
  setStageTool: Dispatch<SetStateAction<StageTool>>,
): Dispatch<SetStateAction<InpaintingTool>> {
  return useMemo(
    () => (nextTool) => {
      setStageTool((currentTool) => {
        const current = resolveInpaintingTool(currentTool);
        const resolved =
          typeof nextTool === "function" ? nextTool(current) : nextTool;
        return resolved === "none" ? "select" : resolved;
      });
    },
    [setStageTool],
  );
}

function resolveInpaintingTool(tool: StageTool): InpaintingTool {
  return isManualInpaintingTool(tool) ? tool : "none";
}

function isManualInpaintingTool(
  tool: StageTool,
): tool is Exclude<InpaintingTool, "none"> {
  return ["mask", "brush", "rectangle", "ellipse", "eraser", "picker"].includes(
    tool,
  );
}

function useTranslateModalUiState() {
  const [translateOptionsOpen, setTranslateOptionsOpen] = useState(false);
  const [retranslatePageId, setRetranslatePageId] = useState<string | null>(
    null,
  );
  const resetTranslateModals = useCallback(() => {
    setTranslateOptionsOpen(false);
    setRetranslatePageId(null);
  }, []);
  return useMemo(
    () => ({
      resetTranslateModals,
      retranslatePageId,
      setRetranslatePageId,
      setTranslateOptionsOpen,
      translateOptionsOpen,
    }),
    [resetTranslateModals, retranslatePageId, translateOptionsOpen],
  );
}

function useWorkspaceZoomControls() {
  const [workspaceZoom, setWorkspaceZoom] = useState(1);
  const [workspaceFitMode, setWorkspaceFitModeState] =
    useState<WorkspaceFitMode>("contain");
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
  const setWorkspaceFitMode = useCallback((fitMode: WorkspaceFitMode) => {
    setWorkspaceFitModeState(fitMode);
    setWorkspaceZoom(1);
  }, []);
  return useMemo(
    () => ({
      workspaceFitMode,
      workspaceZoom,
      zoomInWorkspace,
      zoomOutWorkspace,
      resetWorkspaceZoom,
      setWorkspaceFitMode,
    }),
    [
      workspaceFitMode,
      workspaceZoom,
      zoomInWorkspace,
      zoomOutWorkspace,
      resetWorkspaceZoom,
      setWorkspaceFitMode,
    ],
  );
}
