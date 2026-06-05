import React, { useMemo, useRef, useState } from "react";
import type {
  ChapterSnapshot,
  ImportPreviewSession,
  InpaintingMaskStroke,
  JobState,
  LibraryIndex,
  WorkShareImportPreview
} from "../../shared/types";
import { AppModals } from "./components/AppModals";
import { AppSidebar } from "./components/AppSidebar";
import { AppRightRail } from "./components/AppRightRail";
import { AppWorkspace } from "./components/AppWorkspace";
import { type InpaintingTool } from "./components/InpaintingControlPanel";
import { InpaintingProvider } from "./inpainting/InpaintingContext";
import { FontsProvider } from "./fonts/FontsContext";
import { useBlockEditingActions } from "./hooks/useBlockEditingActions";
import { useConfirmDialog } from "./hooks/useConfirmDialog";
import { useChapterPersistence } from "./hooks/useChapterPersistence";
import { useCurrentChapterUpdater } from "./hooks/useCurrentChapterUpdater";
import { useImportShareActions } from "./hooks/useImportShareActions";
import { useInpaintingActions } from "./hooks/useInpaintingActions";
import { useInpaintingContextBridge } from "./hooks/useInpaintingContextBridge";
import { useInpaintingRetouch } from "./hooks/useInpaintingRetouch";
import { useJobEvents } from "./hooks/useJobEvents";
import { useLibraryActions } from "./hooks/useLibraryActions";
import { useLiveChapterSync } from "./hooks/useLiveChapterSync";
import { usePageImageDataUrls } from "./hooks/usePageImageDataUrls";
import { usePageRetranslationAction } from "./hooks/usePageRetranslationAction";
import { useRegionTranslationPreparation } from "./hooks/useRegionTranslationPreparation";
import { useSettingsDialog } from "./hooks/useSettingsDialog";
import { useStageSize } from "./hooks/useStageSize";
import { useStatusLog } from "./hooks/useStatusLog";
import { useTranslationActions } from "./hooks/useTranslationActions";
import { useWorkspacePointerHandlers } from "./hooks/useWorkspacePointerHandlers";
import {
  regionSelectionToBbox,
  type RegionSelectionState
} from "./lib/appHelpers";
import { resolveProgressSnapshot } from "./lib/jobProgress";
import { countChapterBlocks, countInpaintedPages } from "./lib/inpaintingStats";
import { usePageNavigationHandlers } from "./hooks/usePageNavigationHandlers";
import "./styles.css";

const EMPTY_JOB: JobState = {
  id: "idle",
  kind: "gemma-analysis",
  status: "idle",
  progressText: "대기 중"
};

const INPAINTING_GUIDE_HIDDEN_KEY = "mgt.inpaintingGuide.hidden";

export default function App(): React.JSX.Element {
  const [library, setLibrary] = useState<LibraryIndex>({ workOrder: [], works: [] });
  const [currentChapter, setCurrentChapter] = useState<ChapterSnapshot | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [regionSelection, setRegionSelection] = useState<RegionSelectionState | null>(null);
  const [jobState, setJobState] = useState<JobState>(EMPTY_JOB);
  const { statusLines, appendStatusLine, pushStatus, clearStatusLines } = useStatusLog();
  const [translationSourceOpen, setTranslationSourceOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewSession | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [shareExportOpen, setShareExportOpen] = useState(false);
  const [shareExportBusy, setShareExportBusy] = useState(false);
  const [shareImportPreview, setShareImportPreview] = useState<WorkShareImportPreview | null>(null);
  const [shareImportBusy, setShareImportBusy] = useState(false);
  const { confirmDialog, askConfirm, resolveConfirmDialog } = useConfirmDialog();
  const [inpaintingMode, setInpaintingMode] = useState(false);
  const [inpaintingGuideOpen, setInpaintingGuideOpen] = useState(false);
  const [hideInpaintingGuide, setHideInpaintingGuide] = useState(() =>
    typeof window === "undefined" ? false : window.localStorage.getItem(INPAINTING_GUIDE_HIDDEN_KEY) === "1"
  );
  const [inpaintingTool, setInpaintingTool] = useState<InpaintingTool>("none");
  const [inpaintingBrushRadius, setInpaintingBrushRadius] = useState(28);
  const [inpaintingPaintColor, setInpaintingPaintColor] = useState("#ffffff");
  const [peekOriginal, setPeekOriginal] = useState(false);
  const [patternMaskStrokesByPage, setPatternMaskStrokesByPage] = useState<Record<string, InpaintingMaskStroke[]>>({});
  const [showBlockChrome, setShowBlockChrome] = useState(true);
  const [showTextBlocks, setShowTextBlocks] = useState(true);
  const { settings, settingsOpen, settingsBusy, openSettings, closeSettings, submitSettings, resetSettings, saveSettingsQuietly } = useSettingsDialog(pushStatus);
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const currentChapterRef = useRef<ChapterSnapshot | null>(null);
  const selectedPageIdRef = useRef<string | null>(null);
  const selectedBlockIdRef = useRef<string | null>(null);

  const selectedPage = useMemo(
    () => currentChapter?.pages.find((page) => page.id === selectedPageId) ?? currentChapter?.pages[0] ?? null,
    [currentChapter?.pages, selectedPageId]
  );
  const patternMaskStrokes = useMemo(
    () => (selectedPage ? (patternMaskStrokesByPage[selectedPage.id] ?? []) : []),
    [patternMaskStrokesByPage, selectedPage]
  );
  const selectedPageImagePath = selectedPage?.inpaintedImagePath ?? selectedPage?.imagePath ?? null;
  const { selectedPageImageDataUrl, selectedPageOriginalImageDataUrl, clearPageImageCache } = usePageImageDataUrls({
    chapterId: currentChapter?.id ?? null,
    selectedPage,
    selectedPageImagePath
  });
  const selectedBlock = selectedPage?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const peekAvailable = Boolean(selectedPage?.inpaintedImagePath && selectedPageOriginalImageDataUrl);
  const showingOriginalPeek = inpaintingMode && peekOriginal && peekAvailable;
  const workspaceImageDataUrl = showingOriginalPeek ? selectedPageOriginalImageDataUrl : selectedPageImageDataUrl;
  const jobActive = ["starting", "running", "cancelling"].includes(jobState.status);
  const { clearDirtyTracking, dirty, dirtyPageIdsRef, markDirty, replaceDirtyPageIds, saveNow } = useChapterPersistence({
    currentChapter,
    currentChapterRef,
    setCurrentChapter
  });
  const selectedPageEditLocked = Boolean(jobActive && selectedPage && selectedPage.analysisStatus !== "completed");
  const selectedPageSize = useMemo(
    () => (selectedPage ? { width: selectedPage.width, height: selectedPage.height } : null),
    [selectedPage?.height, selectedPage?.width]
  );
  const stageSize = useStageSize(imageRef, selectedPageSize, selectedPageImageDataUrl);
  const progressSnapshot = useMemo(() => resolveProgressSnapshot(jobState), [jobState]);
  const showProgressBar = jobState.status !== "idle" && !!progressSnapshot;
  const regionSelectionRect = useMemo(() => (regionSelection ? regionSelectionToBbox(regionSelection) : null), [regionSelection]);
  const blockCounts = useMemo(() => countChapterBlocks(currentChapter, selectedPage?.id ?? null), [currentChapter, selectedPage?.id]);
  const inpaintedPageCount = useMemo(() => countInpaintedPages(currentChapter), [currentChapter]);
  const inpaintingToolActive = inpaintingMode && inpaintingTool !== "none";

  const {
    applyChapter,
    clearCurrentChapter,
    deleteRenameTarget,
    openChapter,
    refreshLibrary,
    removePage,
    renameBusy,
    renameChapter,
    renameTarget,
    renameWork,
    reorderChapterInLibrary,
    reorderPageInChapter,
    setRenameTarget,
    submitRename
  } = useLibraryActions({
    askConfirm,
    clearDirtyTracking,
    currentChapter,
    currentChapterRef,
    dirty,
    library,
    pushStatus,
    saveNow,
    setCurrentChapter,
    setLibrary,
    setSelectedBlockId,
    setSelectedPageId
  });
  const modalOpen = Boolean(
    translationSourceOpen || importPreview || shareExportOpen || shareImportPreview || renameTarget || settingsOpen || confirmDialog || inpaintingGuideOpen
  );

  React.useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  React.useEffect(() => {
    setRegionSelection(null);
  }, [selectedPage?.id]);

  React.useEffect(() => {
    if (!currentChapter) {
      setInpaintingMode(false);
      setInpaintingGuideOpen(false);
      setPatternMaskStrokesByPage({});
    }
  }, [currentChapter]);

  React.useEffect(() => {
    if (!settings) {
      return;
    }
    const localStorageHidden = window.localStorage.getItem(INPAINTING_GUIDE_HIDDEN_KEY) === "1";
    const settingsHidden = settings.ui?.inpaintingGuideHidden === true;
    const nextHidden = localStorageHidden || settingsHidden;
    setHideInpaintingGuide(nextHidden);
    if (localStorageHidden && !settingsHidden) {
      void saveSettingsQuietly({
        ...settings,
        ui: {
          ...settings.ui,
          inpaintingGuideHidden: true
        }
      });
    }
  }, [saveSettingsQuietly, settings]);

  const mergeLiveChapter = useLiveChapterSync({
    currentChapter,
    currentChapterRef,
    dirtyPageIdsRef,
    replaceDirtyPageIds,
    selectedBlockId,
    selectedBlockIdRef,
    selectedPageId,
    selectedPageIdRef,
    setCurrentChapter,
    setSelectedBlockId,
    setSelectedPageId
  });

  useJobEvents({
    appendStatusLine,
    currentChapterRef,
    mergeLiveChapter,
    refreshLibrary,
    setJobState
  });

  const { openImportPreview, openShareImportPreview, selectTranslateSource, submitImport, submitShareExport, submitShareImport } =
    useImportShareActions({
      applyChapter,
      askConfirm,
      dirty,
      importPreview,
      mergeLiveChapter,
      openChapter,
      pushStatus,
      refreshLibrary,
      saveNow,
      setImportBusy,
      setImportPreview,
      setShareExportBusy,
      setShareExportOpen,
      setShareImportBusy,
      setShareImportPreview,
      setTranslationSourceOpen,
      shareImportPreview
    });

  const prepareRegionTranslation = useRegionTranslationPreparation({
    inpaintingMode,
    pushStatus
  });

  const { runAnalysis, translateSelectedRegion } = useTranslationActions({
    beforeTranslateRegion: prepareRegionTranslation,
    clearStatusLines,
    currentChapter,
    jobActive,
    mergeLiveChapter,
    pushStatus,
    refreshLibrary,
    saveNow,
    selectedPage,
    setCurrentChapter,
    setJobState,
    setSelectedBlockId
  });

  const updateCurrentChapter = useCurrentChapterUpdater({
    currentChapterRef,
    markDirty,
    setCurrentChapter
  });

  const retranslatePage = usePageRetranslationAction({
    askConfirm,
    currentChapter,
    runAnalysis
  });

  const { applyFontToScope, deleteSelectedBlock, duplicateSelectedBlock, toggleBlockInpaintExcluded, updateSelectedBlock } =
    useBlockEditingActions({
      currentChapter,
      currentChapterRef,
      jobActive,
      markDirty,
      pushStatus,
      selectedBlock,
      selectedPage,
      selectedPageEditLocked,
      setCurrentChapter,
      setSelectedBlockId,
      updateCurrentChapter
    });

  const {
    appendRetouchPoint,
    applyRetouchPoints,
    clearRetouchHistory,
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    lastInpaintingRetouchPointRef,
    redoRetouch,
    retouchBusy,
    retouchCursorPoint,
    retouchPreview,
    retouchRedoStack,
    retouchUndoStack,
    setRetouchCursorPoint,
    setRetouchPreview,
    undoRetouch
  } = useInpaintingRetouch({
    clearPageImageCache,
    currentChapter,
    currentChapterRef,
    inpaintingBrushRadius,
    inpaintingPaintColor,
    inpaintingToolActive,
    jobActive,
    mergeLiveChapter,
    pushStatus,
    selectedPage,
    setCurrentChapter
  });

  const { enterInpaintingMode, exitInpaintingMode, exportInpaintingResults, revertInpainting, runDrawnPatternInpainting, runInpainting } =
    useInpaintingActions({
      askConfirm,
      clearPageImageCache,
      clearRetouchHistory,
      currentChapter,
      dirty,
      hideInpaintingGuide,
      jobActive,
      mergeLiveChapter,
      patternMaskStrokes,
      pushStatus,
      refreshLibrary,
      saveNow,
      selectedPage,
      setInpaintingGuideOpen,
      setInpaintingMode,
      setInpaintingTool,
      setJobState,
      setPatternMaskStrokesByPage,
      setPeekOriginal,
      setRegionSelection,
      setSelectedBlockId,
      setShowBlockChrome,
      setShowTextBlocks
    });

  const { selectPageForReading } = usePageNavigationHandlers({
    currentChapterRef,
    selectedPageIdRef,
    selectedBlockIdRef,
    workspacePanelRef,
    modalOpen,
    inpaintingMode,
    setSelectedPageId,
    setSelectedBlockId,
    undoRetouch,
    redoRetouch
  });

  const {
    onBlockPointerDown,
    onStagePointerDown,
    onStagePointerLeave,
    onStagePointerMove,
    onStagePointerUp,
    startRegionTranslationSelection
  } = useWorkspacePointerHandlers({
    appendRetouchPoint,
    applyRetouchPoints,
    currentChapter,
    imageRef,
    inpaintingBrushRadius,
    inpaintingRetouchDrawingRef,
    inpaintingRetouchPointsRef,
    inpaintingTool,
    inpaintingToolActive,
    jobActive,
    lastInpaintingRetouchPointRef,
    pushStatus,
    regionSelection,
    selectedPage,
    selectedPageEditLocked,
    selectedPageIdRef,
    selectedPageImageDataUrl,
    selectedPageImagePath,
    setCurrentChapter,
    setInpaintingPaintColor,
    setInpaintingTool,
    setPatternMaskStrokesByPage,
    setRegionSelection,
    setRetouchCursorPoint,
    setRetouchPreview,
    setSelectedBlockId,
    stageRef,
    translateSelectedRegion,
    updateCurrentChapter
  });

  const { contextValue: inpaintingContextValue, retouchCursor, retouchPreviewLayer } = useInpaintingContextBridge({
    blockCounts,
    brushColor: inpaintingPaintColor,
    brushRadius: inpaintingBrushRadius,
    canRedo: retouchRedoStack.length > 0,
    canUndo: retouchUndoStack.length > 0,
    currentChapter,
    exportInpaintingResults,
    inpaintedPageCount,
    jobActive,
    jobState,
    maskStrokes: patternMaskStrokes,
    onCancelJob: () => void window.mangaApi.cancelJob(),
    onClearPatternMask: () => {
      if (!selectedPage) {
        return;
      }
      setPatternMaskStrokesByPage((current) => {
        const next = { ...current };
        delete next[selectedPage.id];
        return next;
      });
    },
    onShowGuide: () => setInpaintingGuideOpen(true),
    peekAvailable,
    peeking: showingOriginalPeek,
    progressSnapshot,
    redoRetouch,
    retouchBusy,
    retouchCursorPoint,
    retouchPreview,
    revertInpainting,
    runDrawnPatternInpainting,
    runInpainting,
    selectedPage,
    selectedPageOriginalImageDataUrl,
    setBrushColor: setInpaintingPaintColor,
    setBrushRadius: setInpaintingBrushRadius,
    setPeeking: setPeekOriginal,
    setShowBlockChrome,
    setShowTextBlocks,
    setTool: setInpaintingTool,
    showBlockChrome,
    showTextBlocks,
    tool: inpaintingTool,
    undoRetouch
  });

  return (
    <FontsProvider>
    <main className={`app-shell ${inpaintingMode ? "inpainting-mode" : ""}`}>
      <AppSidebar
        inpaintingMode={inpaintingMode}
        currentChapter={currentChapter}
        selectedPageId={selectedPage?.id ?? null}
        library={library}
        jobActive={jobActive}
        settingsBusy={settingsBusy}
        settingsOpen={settingsOpen}
        onExitInpainting={exitInpaintingMode}
        onOpenTranslationSource={() => setTranslationSourceOpen(true)}
        onOpenBatchImport={() => void openImportPreview("zip-folder")}
        onOpenSettings={() => void openSettings()}
        onOpenLibraryFolder={() => void window.mangaApi.openLibraryFolder()}
        onOpenShareExport={() => setShareExportOpen(true)}
        onOpenShareImport={() => void openShareImportPreview()}
        onOpenChapter={(chapterId) => void openChapter(chapterId)}
        onRenameWork={(workId) => void renameWork(workId)}
        onRenameChapter={(chapterId) => void renameChapter(chapterId)}
        onReorderChapter={reorderChapterInLibrary}
        onSelectPage={selectPageForReading}
        onRetranslatePage={(pageId) => void retranslatePage(pageId)}
        onRemovePage={(pageId) => void removePage(pageId)}
        onReorderPage={reorderPageInChapter}
      />

      <AppWorkspace
        workspacePanelRef={workspacePanelRef}
        selectedPage={selectedPage}
        selectedPageImageDataUrl={workspaceImageDataUrl}
        imageRef={imageRef}
        stageRef={stageRef}
        stageSize={stageSize}
        selectedBlockId={selectedBlockId}
        showTextBlocks={showTextBlocks}
        showBlockChrome={showBlockChrome}
        inpaintingMode={inpaintingMode}
        showingOriginalPeek={showingOriginalPeek}
        inpaintingToolActive={inpaintingToolActive}
        retouchCursor={retouchCursor}
        retouchPreviewLayer={retouchPreviewLayer}
        maskStrokes={inpaintingMode ? patternMaskStrokes : []}
        regionSelectionActive={Boolean(regionSelection?.active)}
        regionSelectionRect={regionSelectionRect}
        jobState={jobState}
        progressSnapshot={progressSnapshot}
        onStagePointerMove={onStagePointerMove}
        onStagePointerUp={onStagePointerUp}
        onStagePointerDown={onStagePointerDown}
        onStagePointerLeave={onStagePointerLeave}
        onBlockPointerDown={onBlockPointerDown}
        onToggleBlockExcluded={toggleBlockInpaintExcluded}
        onOpenTranslationSource={() => setTranslationSourceOpen(true)}
        onOpenBatchImport={() => void openImportPreview("zip-folder")}
        onOpenShareImport={() => void openShareImportPreview()}
      />

      <InpaintingProvider value={inpaintingContextValue}>
        <AppRightRail
          inpaintingMode={inpaintingMode}
          currentChapter={currentChapter}
          selectedPage={selectedPage}
          selectedBlock={selectedBlock}
          selectedPageImageDataUrl={selectedPageImageDataUrl}
          selectedPageEditLocked={selectedPageEditLocked}
          jobState={jobState}
          progressSnapshot={progressSnapshot}
          showProgressBar={showProgressBar}
          showBlockChrome={showBlockChrome}
          showTextBlocks={showTextBlocks}
          jobActive={jobActive}
          statusLines={statusLines}
          areaTranslateSelecting={Boolean(regionSelection?.active)}
          onToggleChrome={() => setShowBlockChrome((value) => !value)}
          onToggleBlocks={() => setShowTextBlocks((value) => !value)}
          onRunPending={() => void runAnalysis("pending")}
          onRunAll={() => void runAnalysis("all")}
          onEnterInpainting={() => void enterInpaintingMode()}
          onCancelJob={() => void window.mangaApi.cancelJob()}
          onStartAreaTranslate={startRegionTranslationSelection}
          onApplyFont={applyFontToScope}
          onUpdateBlock={updateSelectedBlock}
          onDeleteBlock={deleteSelectedBlock}
          onDuplicateBlock={duplicateSelectedBlock}
        />
      </InpaintingProvider>

      <AppModals
        library={library}
        currentWorkId={currentChapter?.workId ?? null}
        translationSourceOpen={translationSourceOpen}
        importPreview={importPreview}
        importBusy={importBusy}
        shareExportOpen={shareExportOpen}
        shareExportBusy={shareExportBusy}
        shareImportPreview={shareImportPreview}
        shareImportBusy={shareImportBusy}
        renameTarget={renameTarget}
        renameBusy={renameBusy}
        settingsOpen={settingsOpen}
        settings={settings}
        settingsBusy={settingsBusy}
        jobActive={jobActive}
        confirmDialog={confirmDialog}
        inpaintingGuideOpen={inpaintingGuideOpen}
        onCancelTranslationSource={() => setTranslationSourceOpen(false)}
        onSelectTranslationSource={(mode) => void selectTranslateSource(mode)}
        onCancelImport={() => setImportPreview(null)}
        onSubmitImport={(payload) => void submitImport(payload)}
        onCancelShareExport={() => {
          if (!shareExportBusy) {
            setShareExportOpen(false);
          }
        }}
        onSubmitShareExport={(request) => void submitShareExport(request)}
        onCancelShareImport={() => {
          if (!shareImportBusy) {
            setShareImportPreview(null);
          }
        }}
        onSubmitShareImport={(payload) => void submitShareImport(payload)}
        onCancelRename={() => {
          if (!renameBusy) {
            setRenameTarget(null);
          }
        }}
        onDeleteRename={() => void deleteRenameTarget()}
        onSubmitRename={(title) => void submitRename(title)}
        onCancelSettings={closeSettings}
        onOpenLogFolder={() => {
          void window.mangaApi.openLogFolder();
        }}
        onResetSettings={() => void resetSettings()}
        onSubmitSettings={(nextSettings) => void submitSettings(nextSettings)}
        onResolveConfirm={resolveConfirmDialog}
        onCloseInpaintingGuide={(hideNextTime) => {
          if (hideNextTime) {
            window.localStorage.setItem(INPAINTING_GUIDE_HIDDEN_KEY, "1");
            setHideInpaintingGuide(true);
            if (settings) {
              void saveSettingsQuietly({
                ...settings,
                ui: {
                  ...settings.ui,
                  inpaintingGuideHidden: true
                }
              });
            }
          }
          setInpaintingGuideOpen(false);
        }}
      />
    </main>
    </FontsProvider>
  );
}

