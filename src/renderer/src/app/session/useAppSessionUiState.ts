import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { InpaintingMaskStroke } from "../../../../shared/inpaintingTypes";
import type { InpaintingTool } from "../../inpainting/inpaintingTypes";
import type { StageTool } from "../../lib/stageTool";
import type { AutoInpaintingEntryScope } from "../../lib/autoInpaintingSelection";
import type { TranslationOptionsInitialScope } from "../../lib/translationSelection";
import {
  clampWorkspaceZoom,
  stepWorkspaceZoom,
  type WorkspaceFitMode,
} from "../../lib/workspaceZoom";
import { clampOriginalImageOpacity } from "../../lib/originalImageOpacity";
import type { GatherTextTab } from "../../lib/gatherText";

export type RightRailMode = "page-blocks" | "block-editor";

export function useAppSessionUiState() {
  const inpaintingUi = useInpaintingUiState();
  const { resetInpaintingUi } = inpaintingUi;
  const [showBlockChrome, setShowBlockChrome] = useState(true);
  const [showTextBlocks, setShowTextBlocks] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [textViewOpen, setTextViewOpen] = useState(false);
  const [textViewTab, setTextViewTab] = useState<GatherTextTab>("overview");
  const [blockLibraryOpen, setBlockLibraryOpen] = useState(false);
  const [styleGuideOpen, setStyleGuideOpen] = useState(false);
  const translateModals = useTranslateModalUiState();
  const jobFlow = useJobFlowState();
  const [editorFloating, setEditorFloating] = useState(false);
  const [rightRailMode, setRightRailMode] =
    useState<RightRailMode>("page-blocks");
  const [stageToolbarHidden, setStageToolbarHidden] = useState(false);
  const zoom = useWorkspaceZoomControls();
  const originalImageOpacity = useOriginalImageOpacityState();

  const toggleEditorFloat = useCallback(
    () => setEditorFloating((floating) => !floating),
    [],
  );
  const openTextView = useCallback((tab: GatherTextTab = "overview") => {
    setTextViewTab(tab);
    setTextViewOpen(true);
  }, []);

  const resetChapterScopedUi = useCallback(() => {
    resetInpaintingUi();
    setBlockLibraryOpen(false);
    setStyleGuideOpen(false);
    setTextViewOpen(false);
    setTextViewTab("overview");
    setRightRailMode("page-blocks");
    translateModals.resetTranslateModals();
    zoom.resetWorkspaceZoom();
  }, [resetInpaintingUi, translateModals, zoom]);

  return {
    ...zoom,
    ...originalImageOpacity,
    ...translateModals,
    ...inpaintingUi,
    ...jobFlow,
    blockLibraryOpen,
    commandPaletteOpen,
    editorFloating,
    rightRailMode,
    openTextView,
    resetChapterScopedUi,
    setCommandPaletteOpen,
    setBlockLibraryOpen,
    setEditorFloating,
    setRightRailMode,
    toggleEditorFloat,
    setShortcutHelpOpen,
    setShowBlockChrome,
    setShowTextBlocks,
    setStageToolbarHidden,
    setStyleGuideOpen,
    setTextViewOpen,
    setTextViewTab,
    shortcutHelpOpen,
    showBlockChrome,
    showTextBlocks,
    stageToolbarHidden,
    styleGuideOpen,
    textViewOpen,
    textViewTab,
  };
}

function useJobFlowState() {
  const [jobFlowActive, setJobFlowActiveState] = useState(false);
  const jobFlowActiveRef = useRef(false);
  const jobFlowCancellationRef = useRef(false);
  const setJobFlowActive = useCallback((active: boolean) => {
    if (active) jobFlowCancellationRef.current = false;
    jobFlowActiveRef.current = active;
    setJobFlowActiveState(active);
  }, []);
  const requestJobFlowCancellation = useCallback(() => {
    if (jobFlowActiveRef.current) jobFlowCancellationRef.current = true;
  }, []);
  return {
    jobFlowActive,
    jobFlowCancellationRef,
    requestJobFlowCancellation,
    setJobFlowActive,
    setTranslationFlowActive: setJobFlowActive,
    translationFlowActive: jobFlowActive,
  };
}

function useOriginalImageOpacityState() {
  const [originalImageOpacityByPage, setOriginalImageOpacityByPage] = useState<
    Record<string, number>
  >({});
  const setOriginalImageOpacityForPage = useCallback(
    (pageId: string, opacity: number): void => {
      const normalized =
        Math.round(clampOriginalImageOpacity(opacity) * 100) / 100;
      setOriginalImageOpacityByPage((current) => {
        if ((current[pageId] ?? 0) === normalized) return current;
        if (normalized === 0) {
          const next = { ...current };
          delete next[pageId];
          return next;
        }
        return { ...current, [pageId]: normalized };
      });
    },
    [],
  );
  return {
    originalImageOpacityByPage,
    setOriginalImageOpacityForPage,
  };
}

function useInpaintingUiState() {
  const [inpaintingGuideOpen, setInpaintingGuideOpen] = useState(false);
  const [autoInpaintingOptionsOpen, setAutoInpaintingOptionsOpen] =
    useState(false);
  const [autoInpaintingEntryScope, setAutoInpaintingEntryScope] =
    useState<AutoInpaintingEntryScope>("select");
  const [exportOptionsOpen, setExportOptionsOpen] = useState(false);
  const [exportOptionsKind, setExportOptionsKind] = useState<"raster" | "psd">(
    "raster",
  );
  const openExportOptions = useCallback((kind: "raster" | "psd") => {
    setExportOptionsKind(kind);
    setExportOptionsOpen(true);
  }, []);
  const [inpaintingBrushRadius, setInpaintingBrushRadius] = useState(28);
  const [inpaintingPaintColor, setInpaintingPaintColor] = useState("#ffffff");
  const [peekOriginal, setPeekOriginal] = useState(false);
  const [patternMaskStrokesByPage, setPatternMaskStrokesByPage] = useState<
    Record<string, InpaintingMaskStroke[]>
  >({});
  const {
    beginTemporaryHandTool,
    endTemporaryHandTool,
    inpaintingTool,
    lastRetouchTool,
    setInpaintingTool,
    setStageTool,
    stageTool,
  } = useWorkspaceToolState();
  const selectWorkspaceTool = useCallback(
    (tool: StageTool) => {
      setStageTool(tool);
      if (isManualInpaintingTool(tool)) {
        setPeekOriginal(false);
      }
    },
    [setStageTool],
  );
  const resetInpaintingUi = useCallback(() => {
    setAutoInpaintingOptionsOpen(false);
    setExportOptionsOpen(false);
    setInpaintingGuideOpen(false);
    setPatternMaskStrokesByPage({});
    setPeekOriginal(false);
  }, []);
  return {
    autoInpaintingOptionsOpen,
    autoInpaintingEntryScope,
    beginTemporaryHandTool,
    endTemporaryHandTool,
    exportOptionsOpen,
    exportOptionsKind,
    openExportOptions,
    inpaintingBrushRadius,
    inpaintingGuideOpen,
    inpaintingPaintColor,
    inpaintingTool,
    lastRetouchTool,
    patternMaskStrokesByPage,
    peekOriginal,
    resetInpaintingUi,
    selectWorkspaceTool,
    setAutoInpaintingOptionsOpen,
    setAutoInpaintingEntryScope,
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

function useWorkspaceToolState() {
  const [
    { stageTool: latchedStageTool, lastRetouchTool },
    setWorkspaceToolState,
  ] = useState<{
    stageTool: StageTool;
    lastRetouchTool: Exclude<InpaintingTool, "none">;
  }>({
    stageTool: "select",
    lastRetouchTool: "brush",
  });
  const [temporaryHandActive, setTemporaryHandActive] = useState(false);
  const setStageTool = useMemo<Dispatch<SetStateAction<StageTool>>>(
    () => (nextTool) => {
      setWorkspaceToolState((current) => {
        const stageTool =
          typeof nextTool === "function"
            ? nextTool(current.stageTool)
            : nextTool;
        const lastRetouchTool = isManualInpaintingTool(stageTool)
          ? stageTool
          : current.lastRetouchTool;
        if (
          stageTool === current.stageTool &&
          lastRetouchTool === current.lastRetouchTool
        ) {
          return current;
        }
        return { stageTool, lastRetouchTool };
      });
    },
    [],
  );
  const stageTool: StageTool = temporaryHandActive ? "hand" : latchedStageTool;
  const inpaintingTool = resolveInpaintingTool(stageTool);
  const setInpaintingTool = useInpaintingToolSetter(setStageTool);
  const beginTemporaryHandTool = useCallback(
    () => setTemporaryHandActive(true),
    [],
  );
  const endTemporaryHandTool = useCallback(
    () => setTemporaryHandActive(false),
    [],
  );
  return {
    beginTemporaryHandTool,
    endTemporaryHandTool,
    inpaintingTool,
    lastRetouchTool,
    setInpaintingTool,
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
  return [
    "mask",
    "brush",
    "rectangle",
    "ellipse",
    "eraser",
    "eraser-rectangle",
    "picker",
  ].includes(tool);
}

function useTranslateModalUiState() {
  const [translateOptionsOpen, setTranslateOptionsOpen] = useState(false);
  const [translateOptionsInitialScope, setTranslateOptionsInitialScope] =
    useState<TranslationOptionsInitialScope>("current-pending");
  const [retranslatePageId, setRetranslatePageId] = useState<string | null>(
    null,
  );
  const openTranslateOptions = useCallback(
    (
      initialScope: TranslationOptionsInitialScope = "current-pending",
    ): void => {
      setTranslateOptionsInitialScope(initialScope);
      setTranslateOptionsOpen(true);
    },
    [],
  );
  const closeTranslateOptions = useCallback(() => {
    setTranslateOptionsOpen(false);
    setTranslateOptionsInitialScope("current-pending");
  }, []);
  const resetTranslateModals = useCallback(() => {
    closeTranslateOptions();
    setRetranslatePageId(null);
  }, [closeTranslateOptions]);
  return useMemo(
    () => ({
      closeTranslateOptions,
      openTranslateOptions,
      resetTranslateModals,
      retranslatePageId,
      setRetranslatePageId,
      translateOptionsInitialScope,
      translateOptionsOpen,
    }),
    [
      closeTranslateOptions,
      openTranslateOptions,
      resetTranslateModals,
      retranslatePageId,
      translateOptionsInitialScope,
      translateOptionsOpen,
    ],
  );
}

function useWorkspaceZoomControls() {
  const [workspaceZoom, setWorkspaceZoom] = useState(1);
  const [workspaceFitMode, setWorkspaceFitModeState] =
    useState<WorkspaceFitMode>("contain");
  const zoomInWorkspace = useCallback(
    () => setWorkspaceZoom((zoom) => stepWorkspaceZoom(zoom, "in")),
    [],
  );
  const zoomOutWorkspace = useCallback(
    () => setWorkspaceZoom((zoom) => stepWorkspaceZoom(zoom, "out")),
    [],
  );
  const changeWorkspaceZoom = useCallback(
    (zoom: number) => setWorkspaceZoom(clampWorkspaceZoom(zoom)),
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
      changeWorkspaceZoom,
      zoomInWorkspace,
      zoomOutWorkspace,
      resetWorkspaceZoom,
      setWorkspaceFitMode,
    }),
    [
      workspaceFitMode,
      workspaceZoom,
      changeWorkspaceZoom,
      zoomInWorkspace,
      zoomOutWorkspace,
      resetWorkspaceZoom,
      setWorkspaceFitMode,
    ],
  );
}
