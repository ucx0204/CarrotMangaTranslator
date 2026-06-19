import React, { useMemo, useRef, useState } from "react";
import type {
  ChapterSnapshot,
  InpaintingMaskStroke,
  JobState,
  LibraryIndex,
} from "../../shared/types";
import { AppModals } from "./components/AppModals";
import { AppSidebar } from "./components/AppSidebar";
import { AppRightRail } from "./components/AppRightRail";
import { AppWorkspace } from "./components/AppWorkspace";
import { CommandPalette } from "./components/CommandPalette";
import { GatherTextModal } from "./components/GatherTextModal";
import { ShortcutHelp } from "./components/ShortcutHelp";
import { ToastViewport } from "./components/ui/ToastViewport";
import { useGlobalHotkeys } from "./hooks/useGlobalHotkeys";
import { toast } from "./lib/toastStore";
import { InpaintingSessionProvider } from "./inpainting/InpaintingSessionProvider";
import type { InpaintingTool } from "./inpainting/inpaintingTypes";
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
import { useAppCommands } from "./hooks/useAppCommands";
import { useImportShareModalController } from "./hooks/useImportShareModalController";
import {
  formatErrorMessage,
  regionSelectionToBbox,
  type RegionSelectionState,
} from "./lib/appHelpers";
import { resolveProgressSnapshot } from "./lib/jobProgress";
import { countChapterBlocks, countInpaintedPages } from "./lib/inpaintingStats";
import { usePageNavigationHandlers } from "./hooks/usePageNavigationHandlers";
import "./styles.css";
import { mangaGateway } from "./api/mangaGateway";

const EMPTY_JOB: JobState = {
  id: "idle",
  kind: "gemma-analysis",
  status: "idle",
  progressText: "대기 중",
};

const INPAINTING_GUIDE_HIDDEN_KEY = "mgt.inpaintingGuide.hidden";

export function AppSession(): React.JSX.Element {
  const [library, setLibrary] = useState<LibraryIndex>({
    workOrder: [],
    works: [],
  });
  const [currentChapter, setCurrentChapter] = useState<ChapterSnapshot | null>(
    null,
  );
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [regionSelection, setRegionSelection] =
    useState<RegionSelectionState | null>(null);
  const [jobState, setJobState] = useState<JobState>(EMPTY_JOB);
  const { statusLines, appendStatusLine, pushStatus, clearStatusLines } =
    useStatusLog();
  const {
    translationSourceOpen,
    setTranslationSourceOpen,
    importPreview,
    setImportPreview,
    importBusy,
    setImportBusy,
    shareExportOpen,
    setShareExportOpen,
    shareExportBusy,
    setShareExportBusy,
    shareImportPreview,
    setShareImportPreview,
    shareImportBusy,
    setShareImportBusy,
  } = useImportShareModalController();
  const { confirmDialog, askConfirm, resolveConfirmDialog } =
    useConfirmDialog();
  const [inpaintingMode, setInpaintingMode] = useState(false);
  const [inpaintingGuideOpen, setInpaintingGuideOpen] = useState(false);
  const [hideInpaintingGuide, setHideInpaintingGuide] = useState(() =>
    typeof window === "undefined"
      ? false
      : window.localStorage.getItem(INPAINTING_GUIDE_HIDDEN_KEY) === "1",
  );
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
  const {
    settings,
    settingsOpen,
    settingsBusy,
    openSettings,
    closeSettings,
    submitSettings,
    resetSettings,
    saveSettingsQuietly,
  } = useSettingsDialog(pushStatus);
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const currentChapterRef = useRef<ChapterSnapshot | null>(null);
  const selectedPageIdRef = useRef<string | null>(null);
  const selectedBlockIdRef = useRef<string | null>(null);
  const prevJobStatusRef = useRef<JobState["status"]>("idle");

  const selectedPage = useMemo(
    () =>
      currentChapter?.pages.find((page) => page.id === selectedPageId) ??
      currentChapter?.pages[0] ??
      null,
    [currentChapter?.pages, selectedPageId],
  );
  const patternMaskStrokes = useMemo(
    () =>
      selectedPage ? (patternMaskStrokesByPage[selectedPage.id] ?? []) : [],
    [patternMaskStrokesByPage, selectedPage],
  );
  const selectedPageImagePath =
    selectedPage?.inpaintedImagePath ?? selectedPage?.imagePath ?? null;
  const neighborImageTargets = useMemo(() => {
    const pages = currentChapter?.pages;
    if (!pages || !selectedPage) {
      return [];
    }
    const index = pages.findIndex((page) => page.id === selectedPage.id);
    if (index < 0) {
      return [];
    }
    const targets: Array<{ pageId: string; imagePath: string }> = [];
    for (const offset of [1, -1]) {
      const neighbor = pages[index + offset];
      if (neighbor) {
        targets.push({
          pageId: neighbor.id,
          imagePath: neighbor.inpaintedImagePath ?? neighbor.imagePath,
        });
      }
    }
    return targets;
  }, [currentChapter?.pages, selectedPage]);
  const {
    selectedPageImageDataUrl,
    selectedPageOriginalImageDataUrl,
    clearPageImageCache,
  } = usePageImageDataUrls({
    chapterId: currentChapter?.id ?? null,
    selectedPage,
    selectedPageImagePath,
    neighborTargets: neighborImageTargets,
  });
  const selectedBlock =
    selectedPage?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const peekAvailable = Boolean(
    selectedPage?.inpaintedImagePath && selectedPageOriginalImageDataUrl,
  );
  const showingOriginalPeek = inpaintingMode && peekOriginal && peekAvailable;
  const workspaceImageDataUrl = showingOriginalPeek
    ? selectedPageOriginalImageDataUrl
    : selectedPageImageDataUrl;
  const jobActive = ["starting", "running", "cancelling"].includes(
    jobState.status,
  );
  const {
    clearDirtyTracking,
    dirty,
    dirtyPageIdsRef,
    markDirty,
    replaceDirtyPageIds,
    resetSaveBaseline,
    saveNow,
  } = useChapterPersistence({
    currentChapter,
    currentChapterRef,
    onSaveError: (message) => {
      pushStatus(`저장 실패: ${message}`);
      toast.error(`저장 실패: ${message}`);
    },
    setCurrentChapter,
  });
  const selectedPageEditLocked = Boolean(
    jobActive && selectedPage && selectedPage.analysisStatus !== "completed",
  );
  const selectedPageSize = useMemo(
    () =>
      selectedPage
        ? { width: selectedPage.width, height: selectedPage.height }
        : null,
    [selectedPage],
  );
  const stageSize = useStageSize(
    imageRef,
    selectedPageSize,
    selectedPageImageDataUrl,
  );
  const progressSnapshot = useMemo(
    () => resolveProgressSnapshot(jobState),
    [jobState],
  );
  const showProgressBar = jobState.status !== "idle" && !!progressSnapshot;
  const regionSelectionRect = useMemo(
    () => (regionSelection ? regionSelectionToBbox(regionSelection) : null),
    [regionSelection],
  );
  const blockCounts = useMemo(
    () => countChapterBlocks(currentChapter, selectedPage?.id ?? null),
    [currentChapter, selectedPage?.id],
  );
  const inpaintedPageCount = useMemo(
    () => countInpaintedPages(currentChapter),
    [currentChapter],
  );
  const inpaintingToolActive = inpaintingMode && inpaintingTool !== "none";
  const cancelJob = React.useCallback(() => {
    void mangaGateway.cancelJob().catch((error) => {
      console.error(error);
      pushStatus(
        formatErrorMessage(error, "작업 취소 요청을 보내지 못했습니다."),
      );
    });
  }, [pushStatus]);
  const openLibraryFolder = React.useCallback(() => {
    void mangaGateway.openLibraryFolder().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, "보관함 폴더를 열지 못했습니다."));
    });
  }, [pushStatus]);
  const openLogFolder = React.useCallback(() => {
    void mangaGateway.openLogFolder().catch((error) => {
      console.error(error);
      pushStatus(formatErrorMessage(error, "로그 폴더를 열지 못했습니다."));
    });
  }, [pushStatus]);

  const {
    applyChapter,
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
    submitRename,
  } = useLibraryActions({
    askConfirm,
    clearDirtyTracking,
    currentChapter,
    currentChapterRef,
    dirty,
    library,
    pushStatus,
    resetSaveBaseline,
    saveNow,
    setCurrentChapter,
    setLibrary,
    setSelectedBlockId,
    setSelectedPageId,
  });
  const overlayModalsOpen = Boolean(
    translationSourceOpen ||
    importPreview ||
    shareExportOpen ||
    shareImportPreview ||
    renameTarget ||
    settingsOpen ||
    confirmDialog ||
    inpaintingGuideOpen ||
    textViewOpen,
  );
  const modalOpen = overlayModalsOpen || commandPaletteOpen || shortcutHelpOpen;

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
    const localStorageHidden =
      window.localStorage.getItem(INPAINTING_GUIDE_HIDDEN_KEY) === "1";
    const settingsHidden = settings.ui?.inpaintingGuideHidden === true;
    const nextHidden = localStorageHidden || settingsHidden;
    setHideInpaintingGuide(nextHidden);
    if (localStorageHidden && !settingsHidden) {
      void saveSettingsQuietly({
        ...settings,
        ui: {
          ...settings.ui,
          inpaintingGuideHidden: true,
        },
      });
    }
  }, [saveSettingsQuietly, settings]);

  React.useEffect(() => {
    const previous = prevJobStatusRef.current;
    const next = jobState.status;
    if (previous === next) {
      return;
    }
    prevJobStatusRef.current = next;
    if (next === "completed") {
      toast.success(jobState.progressText || "작업이 완료되었습니다.");
    } else if (next === "failed") {
      toast.error(jobState.progressText || "작업에 실패했습니다.", {
        action: { label: "로그 폴더 열기", onClick: openLogFolder },
      });
    } else if (next === "cancelled") {
      toast.info("작업이 취소되었습니다.");
    }
  }, [jobState.status, jobState.progressText, openLogFolder]);

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
    setSelectedPageId,
  });

  useJobEvents({
    appendStatusLine,
    currentChapterRef,
    mergeLiveChapter,
    refreshLibrary,
    setJobState,
  });

  const {
    openImportPreview,
    openShareImportPreview,
    selectTranslateSource,
    submitImport,
    submitShareExport,
    submitShareImport,
  } = useImportShareActions({
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
    shareImportPreview,
  });

  const prepareRegionTranslation = useRegionTranslationPreparation({
    inpaintingMode,
    pushStatus,
  });

  const { runAnalysis, translateSelectedRegion } = useTranslationActions({
    beforeTranslateRegion: prepareRegionTranslation,
    clearStatusLines,
    currentChapter,
    currentChapterRef,
    jobActive,
    mergeLiveChapter,
    pushStatus,
    refreshLibrary,
    saveNow,
    selectedPage,
    setCurrentChapter,
    setJobState,
    setSelectedBlockId,
  });

  const updateCurrentChapter = useCurrentChapterUpdater({
    currentChapterRef,
    markDirty,
    setCurrentChapter,
  });

  const retranslatePage = usePageRetranslationAction({
    askConfirm,
    currentChapter,
    runAnalysis,
  });

  const {
    applyFontToScope,
    deleteSelectedBlock,
    duplicateSelectedBlock,
    toggleBlockInpaintExcluded,
    updateSelectedBlock,
  } = useBlockEditingActions({
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
    updateCurrentChapter,
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
    undoRetouch,
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
    setCurrentChapter,
  });

  const {
    enterInpaintingMode,
    exitInpaintingMode,
    exportInpaintingResults,
    revertInpainting,
    runDrawnPatternInpainting,
    runInpainting,
  } = useInpaintingActions({
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
    setShowTextBlocks,
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
    redoRetouch,
  });

  const {
    onBlockPointerDown,
    onStagePointerDown,
    onStagePointerLeave,
    onStagePointerMove,
    onStagePointerUp,
    startRegionTranslationSelection,
    dragHud,
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
    setInpaintingPaintColor,
    setInpaintingTool,
    setPatternMaskStrokesByPage,
    setRegionSelection,
    setRetouchCursorPoint,
    setRetouchPreview,
    setSelectedBlockId,
    stageRef,
    translateSelectedRegion,
    updateCurrentChapter,
  });

  const {
    contextValue: inpaintingContextValue,
    retouchCursor,
    retouchPreviewLayer,
  } = useInpaintingContextBridge({
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
    onCancelJob: cancelJob,
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
    undoRetouch,
  });

  const togglePalette = React.useCallback(
    () => setCommandPaletteOpen((open) => !open),
    [],
  );
  const toggleHelp = React.useCallback(
    () => setShortcutHelpOpen((open) => !open),
    [],
  );
  useGlobalHotkeys({
    blockingModalOpen: overlayModalsOpen,
    paletteOpen: commandPaletteOpen,
    onTogglePalette: togglePalette,
    onToggleHelp: toggleHelp,
  });

  const commands = useAppCommands({
    currentChapter,
    jobActive,
    inpaintingMode,
    runAnalysis: (runMode) => runAnalysis(runMode),
    enterInpaintingMode,
    exitInpaintingMode,
    cancelJob,
    openImportPreview,
    openShareImportPreview,
    openSettings,
    openLibraryFolder,
    openLogFolder,
    openTranslationSource: () => setTranslationSourceOpen(true),
    openShareExport: () => setShareExportOpen(true),
    openShortcutHelp: () => setShortcutHelpOpen(true),
    openTextView: () => setTextViewOpen(true),
  });

  return (
    <>
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
          onOpenLibraryFolder={openLibraryFolder}
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
          dragHud={dragHud}
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
          onOpenSettings={() => void openSettings()}
        />

        <InpaintingSessionProvider value={inpaintingContextValue}>
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
            onOpenTextView={() => setTextViewOpen(true)}
            onRunPending={() => void runAnalysis("pending")}
            onRunAll={() => void runAnalysis("all")}
            onEnterInpainting={() => void enterInpaintingMode()}
            onCancelJob={cancelJob}
            onStartAreaTranslate={startRegionTranslationSelection}
            onApplyFont={applyFontToScope}
            onUpdateBlock={updateSelectedBlock}
            onDeleteBlock={deleteSelectedBlock}
            onDuplicateBlock={duplicateSelectedBlock}
          />
        </InpaintingSessionProvider>

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
          onOpenLogFolder={openLogFolder}
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
                    inpaintingGuideHidden: true,
                  },
                });
              }
            }
            setInpaintingGuideOpen(false);
          }}
        />
      </main>
      <CommandPalette
        open={commandPaletteOpen}
        commands={commands}
        onClose={() => setCommandPaletteOpen(false)}
      />
      <ShortcutHelp
        open={shortcutHelpOpen}
        onClose={() => setShortcutHelpOpen(false)}
      />
      {textViewOpen ? (
        <GatherTextModal
          chapter={currentChapter}
          page={selectedPage}
          onClose={() => setTextViewOpen(false)}
        />
      ) : null}
      <ToastViewport />
    </>
  );
}
