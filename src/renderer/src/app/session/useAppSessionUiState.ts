import { useCallback, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { InpaintingMaskStroke } from "../../../../shared/inpaintingTypes";
import type { InpaintingTool } from "../../inpainting/inpaintingTypes";
import type { StageTool } from "../../lib/stageTool";
import type { AutoInpaintingEntryScope } from "../../lib/autoInpaintingSelection";
import type { TranslationOptionsInitialScope } from "../../lib/translationSelection";
import { clampOriginalImageOpacity } from "../../lib/originalImageOpacity";
import { useSoundEffectReviewUiState } from "./useSoundEffectReviewUiState";
import { useWorkspaceZoomControls } from "./useWorkspaceZoomControls";

export type RightRailMode = "page-blocks" | "block-editor";

// eslint-disable-next-line max-lines-per-function -- this top-level hook only aggregates independently scoped UI state and reset handles
export function useAppSessionUiState() {
  const inpaintingUi = useInpaintingUiState();
  const { resetInpaintingUi } = inpaintingUi;
  const [showBlockChrome, setShowBlockChrome] = useState(true);
  const [showTextBlocks, setShowTextBlocks] = useState(true);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [textViewOpen, setTextViewOpen] = useState(false);
  const [blockLibraryOpen, setBlockLibraryOpen] = useState(false);
  const [fontManagerOpen, setFontManagerOpen] = useState(false);
  const [conditionalBatchOpen, setConditionalBatchOpen] = useState(false);
  const [batchInitialFind, setBatchInitialFind] = useState("");
  const [batchInitialReplace, setBatchInitialReplace] = useState("");
  const [styleGuideOpen, setStyleGuideOpen] = useState(false);
  const [styleGuideBackgrounded, setStyleGuideBackgrounded] = useState(false);
  const translateModals = useTranslateModalUiState();
  const jobFlow = useJobFlowState();
  const [editorFloating, setEditorFloating] = useState(false);
  const editorTextTab = useEditorTextTabRequest();
  const [rightRailMode, setRightRailMode] =
    useState<RightRailMode>("page-blocks");
  const [stageToolbarHidden, setStageToolbarHidden] = useState(false);
  const soundEffectReview = useSoundEffectReviewUiState();
  const zoom = useWorkspaceZoomControls();
  const originalImageOpacity = useOriginalImageOpacityState();

  const toggleEditorFloat = useCallback(
    () => setEditorFloating((floating) => !floating),
    [],
  );
  const openTextView = useCallback(() => setTextViewOpen(true), []);

  const resetChapterScopedUi = useCallback(() => {
    resetInpaintingUi();
    setBlockLibraryOpen(false);
    setFontManagerOpen(false);
    setConditionalBatchOpen(false);
    setBatchInitialFind("");
    setBatchInitialReplace("");
    setStyleGuideOpen(false);
    setStyleGuideBackgrounded(false);
    setTextViewOpen(false);
    setRightRailMode("page-blocks");
    soundEffectReview.resetSoundEffectReviewUi();
    translateModals.resetTranslateModals();
    zoom.resetWorkspaceZoom();
  }, [resetInpaintingUi, soundEffectReview, translateModals, zoom]);

  return {
    ...zoom,
    ...originalImageOpacity,
    ...translateModals,
    ...inpaintingUi,
    ...jobFlow,
    ...soundEffectReview,
    blockLibraryOpen,
    fontManagerOpen,
    conditionalBatchOpen,
    conditionalBatchInitialFind: batchInitialFind,
    conditionalBatchInitialReplace: batchInitialReplace,
    commandPaletteOpen,
    editorFloating,
    ...editorTextTab,
    rightRailMode,
    openTextView,
    resetChapterScopedUi,
    setCommandPaletteOpen,
    setBlockLibraryOpen,
    setFontManagerOpen,
    setConditionalBatchOpen,
    setConditionalBatchInitialFind: setBatchInitialFind,
    setConditionalBatchInitialReplace: setBatchInitialReplace,
    setEditorFloating,
    setRightRailMode,
    toggleEditorFloat,
    setShortcutHelpOpen,
    setShowBlockChrome,
    setShowTextBlocks,
    setStageToolbarHidden,
    setStyleGuideOpen,
    setStyleGuideBackgrounded,
    setTextViewOpen,
    shortcutHelpOpen,
    showBlockChrome,
    showTextBlocks,
    stageToolbarHidden,
    styleGuideOpen,
    styleGuideBackgrounded,
    textViewOpen,
  };
}

function useEditorTextTabRequest() {
  const [editorTextTabRequestToken, setToken] = useState(0);
  const requestEditorTextTab = useCallback(() => {
    setToken((current) => current + 1);
  }, []);
  return { editorTextTabRequestToken, requestEditorTextTab };
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
