import React, { useCallback, useMemo, useRef, useState } from "react";
import type {
  BBox,
  ChapterSnapshot,
  ImportPreviewSession,
  InpaintingMaskStroke,
  JobState,
  LibraryIndex,
  TranslationBlock,
  WorkShareImportPreview
} from "../../shared/types";
import {
  applyEditableBlockBbox,
  resolveEditableBlockBbox
} from "../../shared/geometry";
import { isUsableRegionBbox } from "../../shared/region";
import { AppModals, type RenameTarget } from "./components/AppModals";
import { AppSidebar } from "./components/AppSidebar";
import { AppRightRail } from "./components/AppRightRail";
import { AppWorkspace } from "./components/AppWorkspace";
import { type InpaintingTool } from "./components/InpaintingControlPanel";
import { InpaintingProvider, type InpaintingContextValue } from "./inpainting/InpaintingContext";
import { FontsProvider } from "./fonts/FontsContext";
import { useBlockEditingActions } from "./hooks/useBlockEditingActions";
import { useConfirmDialog } from "./hooks/useConfirmDialog";
import { useChapterPersistence } from "./hooks/useChapterPersistence";
import { useImportShareActions } from "./hooks/useImportShareActions";
import { useInpaintingActions } from "./hooks/useInpaintingActions";
import { useInpaintingRetouch } from "./hooks/useInpaintingRetouch";
import { useJobEvents } from "./hooks/useJobEvents";
import { usePageImageDataUrls } from "./hooks/usePageImageDataUrls";
import { useSettingsDialog } from "./hooks/useSettingsDialog";
import { useStageSize } from "./hooks/useStageSize";
import { useStatusLog } from "./hooks/useStatusLog";
import { useTranslationActions } from "./hooks/useTranslationActions";
import {
  formatErrorMessage,
  regionSelectionToBbox,
  reorderByTarget,
  reorderRecordsByIdOrder,
  type RegionSelectionState
} from "./lib/appHelpers";
import { mergeLiveChapterPreservingDirtyPages, resolveSelectionAfterChapterSync } from "./lib/chapterSync";
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

function isSameStringOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

type DragMode = "move" | "resize";

type DragState = {
  mode: DragMode;
  blockId: string;
  startX: number;
  startY: number;
  startBbox: BBox;
};

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
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
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
  const { settings, settingsOpen, settingsBusy, openSettings, closeSettings, submitSettings, resetSettings } = useSettingsDialog(pushStatus);
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
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
    jobActive,
    setCurrentChapter
  });
  const modalOpen = Boolean(
    translationSourceOpen || importPreview || shareExportOpen || shareImportPreview || renameTarget || settingsOpen || confirmDialog || inpaintingGuideOpen
  );
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
  const refreshLibrary = useCallback(async () => {
    const next = await window.mangaApi.getLibrary();
    setLibrary(next);
  }, []);

  React.useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  React.useEffect(() => {
    currentChapterRef.current = currentChapter;
  }, [currentChapter]);

  React.useEffect(() => {
    selectedPageIdRef.current = selectedPageId;
  }, [selectedPageId]);

  React.useEffect(() => {
    selectedBlockIdRef.current = selectedBlockId;
  }, [selectedBlockId]);

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

  const mergeLiveChapter = useCallback((chapter: ChapterSnapshot) => {
    const current = currentChapterRef.current;
    if (current && current.id !== chapter.id) {
      return;
    }

    const mergeResult = mergeLiveChapterPreservingDirtyPages(chapter, current, dirtyPageIdsRef.current);
    replaceDirtyPageIds(mergeResult.preservedDirtyPageIds);
    currentChapterRef.current = mergeResult.chapter;

    setCurrentChapter((currentChapter) => {
      if (currentChapter && currentChapter.id !== mergeResult.chapter.id) {
        return currentChapter;
      }
      return mergeResult.chapter;
    });

    const selection = resolveSelectionAfterChapterSync(mergeResult.chapter, selectedPageIdRef.current, selectedBlockIdRef.current);
    setSelectedPageId(selection.selectedPageId);
    setSelectedBlockId(selection.selectedBlockId);
  }, [dirtyPageIdsRef, replaceDirtyPageIds]);

  useJobEvents({
    appendStatusLine,
    currentChapterRef,
    mergeLiveChapter,
    refreshLibrary,
    setJobState
  });

  const clearCurrentChapter = useCallback(() => {
    setCurrentChapter(null);
    currentChapterRef.current = null;
    setSelectedPageId(null);
    setSelectedBlockId(null);
    clearDirtyTracking();
  }, [clearDirtyTracking]);

  const openChapter = useCallback(
    async (chapterId: string) => {
      if (dirty) {
        await saveNow();
      }
      const chapter = await window.mangaApi.openChapter(chapterId);
      clearDirtyTracking();
      currentChapterRef.current = chapter;
      setCurrentChapter(chapter);
      setSelectedPageId(chapter.pages[0]?.id ?? null);
      setSelectedBlockId(null);
    },
    [clearDirtyTracking, dirty, saveNow]
  );

  const applyChapter = useCallback((chapter: ChapterSnapshot | undefined, fallbackStatus?: string) => {
    if (!chapter) {
      return;
    }
    clearDirtyTracking();
    currentChapterRef.current = chapter;
    setCurrentChapter(chapter);
    setSelectedPageId((current) => (chapter.pages.some((page) => page.id === current) ? current : chapter.pages[0]?.id ?? null));
    setSelectedBlockId(null);
    if (fallbackStatus) {
      pushStatus(fallbackStatus);
    }
  }, [clearDirtyTracking, pushStatus]);

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

  const prepareRegionTranslation = useCallback(async () => {
    if (!inpaintingMode) {
      return;
    }
    pushStatus("영역 번역을 위해 Flux 인페인팅 런타임을 정리합니다.");
    await window.mangaApi.disposeInpaintingEngine();
  }, [inpaintingMode, pushStatus]);

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

  const { enterInpaintingMode, exitInpaintingMode, exportInpaintingResults, runDrawnPatternInpainting, runInpainting } =
    useInpaintingActions({
      askConfirm,
      clearPageImageCache,
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

  const startRegionTranslationSelection = useCallback(() => {
    if (!selectedPage || !selectedPageImageDataUrl || jobActive) {
      return;
    }

    if (regionSelection?.active) {
      setRegionSelection(null);
      pushStatus("영역 번역 선택을 취소했습니다.");
      return;
    }

    setSelectedBlockId(null);
    setInpaintingTool("none");
    setRegionSelection({
      active: true,
      dragging: false,
      start: { x: 0, y: 0 },
      current: { x: 0, y: 0 }
    });
    pushStatus("번역할 영역을 드래그하세요.");
  }, [jobActive, pushStatus, regionSelection?.active, selectedPage, selectedPageImageDataUrl]);

  const updateCurrentChapter = useCallback((pageId: string, updater: (chapter: ChapterSnapshot) => ChapterSnapshot) => {
    setCurrentChapter((current) => {
      if (!current) {
        return current;
      }
      const next = updater(current);
      currentChapterRef.current = next;
      markDirty(pageId);
      return next;
    });
  }, [markDirty]);

  const removePage = useCallback(
    async (pageId: string) => {
      if (!currentChapter) {
        return;
      }
      const page = currentChapter.pages.find((candidate) => candidate.id === pageId);
      if (!page) {
        return;
      }
      const confirmed = await askConfirm(
        "페이지 삭제",
        "정말 삭제하시겠습니까?",
        "이 페이지와 해당 번역 결과가 보관함에서 삭제됩니다."
      );
      if (!confirmed) {
        return;
      }

      const previousOrder = currentChapter.pages.map((candidate) => candidate.id);
      const nextChapter = await window.mangaApi.deletePage(currentChapter.id, pageId);
      applyChapter(nextChapter);
      const currentIndex = previousOrder.indexOf(pageId);
      const nextId = previousOrder[currentIndex + 1] ?? previousOrder[currentIndex - 1] ?? null;
      setSelectedPageId(nextId && nextChapter.pages.some((candidate) => candidate.id === nextId) ? nextId : nextChapter.pages[0]?.id ?? null);
      pushStatus(`${page.name} 페이지를 삭제했습니다.`);
      await refreshLibrary();
    },
    [applyChapter, askConfirm, currentChapter, pushStatus, refreshLibrary]
  );

  const retranslatePage = useCallback(
    async (pageId: string) => {
      const page = currentChapter?.pages.find((candidate) => candidate.id === pageId);
      if (!page || !currentChapter) {
        return;
      }
      const confirmed = await askConfirm(
        "페이지 재번역",
        "정말 재번역 하시겠습니까?",
        "기존 번역 결과와 수정 내용이 이 페이지에서 덮어써집니다."
      );
      if (!confirmed) {
        return;
      }
      await runAnalysis("single-page", pageId);
    },
    [askConfirm, currentChapter, runAnalysis]
  );

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

  const getNormalizedImagePoint = useCallback((event: React.PointerEvent): { x: number; y: number } | null => {
    const stage = stageRef.current;
    if (!stage) {
      return null;
    }
    const rect = imageRef.current?.getBoundingClientRect() ?? stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: Math.max(0, Math.min(1000, ((event.clientX - rect.left) / rect.width) * 1000)),
      y: Math.max(0, Math.min(1000, ((event.clientY - rect.top) / rect.height) * 1000))
    };
  }, []);

  const getImagePixelPoint = useCallback(
    (event: React.PointerEvent): { x: number; y: number } | null => {
      const stage = stageRef.current;
      const page = selectedPage;
      if (!stage || !page) {
        return null;
      }
      const rect = imageRef.current?.getBoundingClientRect() ?? stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      return {
        x: Math.max(0, Math.min(page.width - 1, ((event.clientX - rect.left) / rect.width) * page.width)),
        y: Math.max(0, Math.min(page.height - 1, ((event.clientY - rect.top) / rect.height) * page.height))
      };
    },
    [selectedPage]
  );

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

  const retouchCursor =
    inpaintingTool === "brush" || inpaintingTool === "eraser" || inpaintingTool === "mask"
      ? {
          point: retouchCursorPoint,
          radiusPx: inpaintingBrushRadius,
          mode: inpaintingTool,
          color: inpaintingTool === "brush" ? inpaintingPaintColor : inpaintingTool === "mask" ? "#ff9f1c" : "#70b7ff"
        }
      : null;

  const retouchPreviewLayer =
    retouchPreview && retouchPreview.points.length > 0
      ? {
          ...retouchPreview,
          originalImageDataUrl: retouchPreview.mode === "eraser" ? selectedPageOriginalImageDataUrl : ""
        }
      : null;

  const { onWorkspaceWheel, selectPageForReading } = usePageNavigationHandlers({
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

  const revertInpainting = useCallback(
    async (scope: "page" | "chapter") => {
      if (!currentChapter || jobActive) {
        return;
      }
      if (scope === "page" && !selectedPage) {
        return;
      }
      const confirmed = await askConfirm(
        scope === "page" ? "이 페이지 원본으로 되돌리기" : "전체 페이지 원본으로 되돌리기",
        scope === "page" ? "현재 페이지의 인페인팅 결과를 원본 이미지로 되돌립니다." : "현재 화의 인페인팅 결과를 원본 이미지로 되돌립니다.",
        "번역 블록과 좌표는 유지하고, 지워진 이미지 결과만 해제합니다."
      );
      if (!confirmed) {
        return;
      }
      const result = await window.mangaApi.revertInpainting(
        scope === "page"
          ? { chapterId: currentChapter.id, scope: "page", pageId: selectedPage!.id }
          : { chapterId: currentChapter.id, scope: "chapter" }
      );
      clearPageImageCache();
      mergeLiveChapter(result.chapter);
      clearRetouchHistory();
      pushStatus(`인페인팅 되돌리기 완료: ${result.pagesChanged}페이지`);
    },
    [askConfirm, clearPageImageCache, clearRetouchHistory, currentChapter, jobActive, mergeLiveChapter, pushStatus, selectedPage]
  );

  const onBlockPointerDown = (event: React.PointerEvent, block: TranslationBlock, mode: DragMode) => {
    if (!stageRef.current || selectedPageEditLocked || regionSelection?.active || inpaintingToolActive) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setSelectedBlockId(block.id);
    const pageSize = selectedPage ? { width: selectedPage.width, height: selectedPage.height } : null;
    const displayText = block.translatedText || block.sourceText || "...";
    const target = resolveEditableBlockBbox(block, pageSize, displayText);
    dragRef.current = {
      mode,
      blockId: block.id,
      startX: event.clientX,
      startY: event.clientY,
      startBbox: target.bbox
    };
    stageRef.current.setPointerCapture(event.pointerId);
  };

  const onStagePointerDown = (event: React.PointerEvent) => {
    if (inpaintingToolActive) {
      const point = getImagePixelPoint(event);
      if (!point || !stageRef.current) {
        return;
      }
      if (inpaintingTool === "brush" || inpaintingTool === "eraser" || inpaintingTool === "mask") {
        setRetouchCursorPoint(point);
      }
      event.preventDefault();
      event.stopPropagation();
      setSelectedBlockId(null);
      if (inpaintingTool === "picker") {
        const imagePath = selectedPageImagePath ?? selectedPage?.imagePath;
        if (imagePath) {
          void window.mangaApi
            .sampleInpaintingColor({ imagePath, x: point.x, y: point.y })
            .then((result) => {
              setInpaintingPaintColor(result.color);
              pushStatus(`붓 색상을 ${result.color}로 선택했습니다. 계속 다른 색을 뽑거나 붓으로 전환하세요.`);
            })
            .catch((error) => {
              console.error(error);
              pushStatus("색상을 가져오지 못했습니다.");
            });
        }
        return;
      }
      inpaintingRetouchDrawingRef.current = true;
      inpaintingRetouchPointsRef.current = [];
      lastInpaintingRetouchPointRef.current = null;
      setRetouchPreview(null);
      appendRetouchPoint(point, inpaintingTool);
      stageRef.current.setPointerCapture(event.pointerId);
      return;
    }

    if (!regionSelection?.active) {
      setSelectedBlockId(null);
      return;
    }

    const point = getNormalizedImagePoint(event);
    if (!point || !stageRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setSelectedBlockId(null);
    setRegionSelection({
      active: true,
      dragging: true,
      start: point,
      current: point
    });
    stageRef.current.setPointerCapture(event.pointerId);
  };

  const onStagePointerMove = (event: React.PointerEvent) => {
    if (inpaintingToolActive) {
      const point = getImagePixelPoint(event);
      if (point && (inpaintingTool === "brush" || inpaintingTool === "eraser" || inpaintingTool === "mask")) {
        setRetouchCursorPoint(point);
      }
      if (point && inpaintingRetouchDrawingRef.current && (inpaintingTool === "brush" || inpaintingTool === "eraser" || inpaintingTool === "mask")) {
        appendRetouchPoint(point, inpaintingTool);
      }
      return;
    }

    if (regionSelection?.active && regionSelection.dragging) {
      const point = getNormalizedImagePoint(event);
      if (point) {
        setRegionSelection((current) => (current?.active ? { ...current, current: point } : current));
      }
      return;
    }

    const drag = dragRef.current;
    const page = selectedPage;
    const stage = stageRef.current;
    if (!drag || !page || !stage || !currentChapter || selectedPageEditLocked) {
      return;
    }
    const rect = imageRef.current?.getBoundingClientRect() ?? stage.getBoundingClientRect();
    const dx = ((event.clientX - drag.startX) / Math.max(1, rect.width)) * 1000;
    const dy = ((event.clientY - drag.startY) / Math.max(1, rect.height)) * 1000;
    const next =
      drag.mode === "move"
        ? {
            ...drag.startBbox,
            x: drag.startBbox.x + dx,
            y: drag.startBbox.y + dy
          }
        : {
            ...drag.startBbox,
            w: drag.startBbox.w + dx,
            h: drag.startBbox.h + dy
          };

    updateCurrentChapter(page.id, (chapter) => ({
      ...chapter,
      pages: chapter.pages.map((candidate) =>
        candidate.id !== page.id
          ? candidate
          : {
              ...candidate,
              updatedAt: new Date().toISOString(),
              blocks: candidate.blocks.map((block) =>
                block.id === drag.blockId
                  ? applyEditableBlockBbox(block, next, { width: page.width, height: page.height }, block.translatedText || block.sourceText || "...")
                  : block
              )
            }
      )
    }));
  };

  const onStagePointerUp = (event: React.PointerEvent) => {
    if (inpaintingRetouchDrawingRef.current) {
      if (stageRef.current) {
        stageRef.current.releasePointerCapture(event.pointerId);
      }
      inpaintingRetouchDrawingRef.current = false;
      lastInpaintingRetouchPointRef.current = null;
      const points = inpaintingRetouchPointsRef.current;
      inpaintingRetouchPointsRef.current = [];
      if (inpaintingTool === "brush" || inpaintingTool === "eraser") {
        void applyRetouchPoints(inpaintingTool, points);
      } else if (inpaintingTool === "mask" && points.length > 0) {
        const pageId = selectedPageIdRef.current;
        if (pageId) {
          setPatternMaskStrokesByPage((current) => ({
            ...current,
            [pageId]: [...(current[pageId] ?? []), { points, radiusPx: inpaintingBrushRadius }].slice(-200)
          }));
        }
      }
      window.setTimeout(() => setRetouchPreview(null), 180);
      return;
    }

    if (regionSelection?.active && regionSelection.dragging) {
      if (stageRef.current) {
        stageRef.current.releasePointerCapture(event.pointerId);
      }
      const bbox = regionSelectionToBbox(regionSelection);
      setRegionSelection(null);
      if (!isUsableRegionBbox(bbox, 10)) {
        pushStatus("선택 영역이 너무 작습니다.");
        return;
      }
      void translateSelectedRegion(bbox);
      return;
    }

    if (dragRef.current && stageRef.current) {
      stageRef.current.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  };

  const onStagePointerLeave = () => {
    if (!inpaintingRetouchDrawingRef.current) {
      setRetouchCursorPoint(null);
    }
  };

  const renameWork = useCallback((workId: string) => {
    const work = library.works.find((candidate) => candidate.id === workId);
    if (!work) {
      return;
    }
    setRenameTarget({ kind: "work", id: workId, title: work.title });
  }, [library.works]);

  const renameChapter = useCallback((chapterId: string) => {
    const chapter =
      library.works.flatMap((work) => work.chapters).find((candidate) => candidate.id === chapterId) ??
      (currentChapter ? { id: currentChapter.id, title: currentChapter.title } : null);
    if (!chapter) {
      return;
    }
    setRenameTarget({ kind: "chapter", id: chapterId, title: chapter.title });
  }, [currentChapter, library.works]);

  const submitRename = useCallback(async (title: string) => {
    if (!renameTarget) {
      return;
    }

    setRenameBusy(true);
    try {
      if (renameTarget.kind === "work") {
        setLibrary(await window.mangaApi.renameWork(renameTarget.id, title));
      } else {
        if (currentChapter?.id === renameTarget.id && dirty) {
          await saveNow();
        }
        setLibrary(await window.mangaApi.renameChapter(renameTarget.id, title));
        if (currentChapter?.id === renameTarget.id) {
          applyChapter(await window.mangaApi.openChapter(renameTarget.id));
        }
      }
      setRenameTarget(null);
    } finally {
      setRenameBusy(false);
    }
  }, [applyChapter, currentChapter, dirty, renameTarget, saveNow]);

  const deleteRenameTarget = useCallback(async () => {
    if (!renameTarget) {
      return;
    }

    const isCurrentChapter = currentChapter?.id === renameTarget.id;
    const isCurrentWork = renameTarget.kind === "work" && currentChapter?.workId === renameTarget.id;
    const confirmed = await askConfirm(
      renameTarget.kind === "work" ? "작품 삭제" : "화 삭제",
      "정말 삭제하시겠습니까?",
      renameTarget.kind === "work"
        ? `"${renameTarget.title}" 작품과 포함된 모든 화, 페이지, 번역 결과가 보관함에서 삭제됩니다.`
        : `"${renameTarget.title}" 화와 포함된 모든 페이지, 번역 결과가 보관함에서 삭제됩니다.`
    );
    if (!confirmed) {
      return;
    }

    setRenameBusy(true);
    try {
      if ((isCurrentChapter || isCurrentWork) && dirty) {
        await saveNow();
      }

      if (renameTarget.kind === "work") {
        setLibrary(await window.mangaApi.deleteWork(renameTarget.id));
        if (isCurrentWork) {
          clearCurrentChapter();
        }
        pushStatus(`${renameTarget.title} 작품을 삭제했습니다.`);
      } else {
        setLibrary(await window.mangaApi.deleteChapter(renameTarget.id));
        if (isCurrentChapter) {
          clearCurrentChapter();
        }
        pushStatus(`${renameTarget.title} 화를 삭제했습니다.`);
      }

      setRenameTarget(null);
    } catch (error) {
      console.error(error);
      pushStatus(renameTarget.kind === "work" ? "작품을 삭제하지 못했습니다." : "화를 삭제하지 못했습니다.");
    } finally {
      setRenameBusy(false);
    }
  }, [askConfirm, clearCurrentChapter, currentChapter?.id, currentChapter?.workId, dirty, pushStatus, renameTarget, saveNow]);

  const reorderChapterInLibrary = useCallback(
    (workId: string, sourceChapterId: string, targetChapterId: string) => {
      const work = library.works.find((candidate) => candidate.id === workId);
      if (!work) {
        return;
      }
      const previousOrder = work.chapterOrder;
      const nextOrder = reorderByTarget(work.chapterOrder, sourceChapterId, targetChapterId);
      setLibrary((current) => ({
        ...current,
        works: current.works.map((candidate) =>
          candidate.id === workId
            ? {
                ...candidate,
                chapterOrder: nextOrder,
                chapters: reorderRecordsByIdOrder(candidate.chapters, nextOrder)
              }
            : candidate
        )
      }));
      void window.mangaApi
        .reorderChapters(workId, nextOrder)
        .then(setLibrary)
        .catch((error) => {
          console.error(error);
          setLibrary((current) => ({
            ...current,
            works: current.works.map((candidate) =>
              candidate.id === workId && isSameStringOrder(candidate.chapterOrder, nextOrder)
                ? {
                    ...candidate,
                    chapterOrder: previousOrder,
                    chapters: reorderRecordsByIdOrder(candidate.chapters, previousOrder)
                  }
                : candidate
            )
          }));
          const message = formatErrorMessage(error, "화 순서를 저장하지 못했습니다.");
          pushStatus(`${message} 이전 순서로 되돌렸습니다.`);
        });
    },
    [library.works, pushStatus]
  );

  const reorderPageInChapter = useCallback(
    (sourcePageId: string, targetPageId: string) => {
      if (!currentChapter) {
        return;
      }
      const previousOrder = currentChapter.pageOrder;
      const nextOrder = reorderByTarget(currentChapter.pageOrder, sourcePageId, targetPageId);
      setCurrentChapter((chapter) => {
        if (!chapter || chapter.id !== currentChapter.id) {
          return chapter;
        }
        const nextChapter = {
          ...chapter,
          pageOrder: nextOrder,
          pages: reorderRecordsByIdOrder(chapter.pages, nextOrder)
        };
        currentChapterRef.current = nextChapter;
        return nextChapter;
      });
      void window.mangaApi
        .reorderPages(currentChapter.id, nextOrder)
        .then((chapter) => {
          applyChapter(chapter);
          void refreshLibrary();
        })
        .catch((error) => {
          console.error(error);
          setCurrentChapter((chapter) => {
            if (!chapter || chapter.id !== currentChapter.id || !isSameStringOrder(chapter.pageOrder, nextOrder)) {
              return chapter;
            }
            const rolledBackChapter = {
              ...chapter,
              pageOrder: previousOrder,
              pages: reorderRecordsByIdOrder(chapter.pages, previousOrder)
            };
            currentChapterRef.current = rolledBackChapter;
            return rolledBackChapter;
          });
          const message = formatErrorMessage(error, "페이지 순서를 저장하지 못했습니다.");
          pushStatus(`${message} 이전 순서로 되돌렸습니다.`);
        });
    },
    [applyChapter, currentChapter, pushStatus, refreshLibrary]
  );

  const inpaintingContextValue: InpaintingContextValue = {
    currentChapter,
    selectedPage,
    blockCounts,
    inpaintedPageCount,
    tool: inpaintingTool,
    brushRadius: inpaintingBrushRadius,
    brushColor: inpaintingPaintColor,
    maskStrokeCount: patternMaskStrokes.length,
    canUndo: !retouchBusy && retouchUndoStack.length > 0,
    canRedo: !retouchBusy && retouchRedoStack.length > 0,
    jobState,
    progressSnapshot,
    showBlockChrome,
    showTextBlocks,
    jobActive,
    peekAvailable,
    peeking: showingOriginalPeek,
    onSelectTool: setInpaintingTool,
    onBrushRadiusChange: setInpaintingBrushRadius,
    onBrushColorChange: setInpaintingPaintColor,
    onUndoRetouch: () => void undoRetouch(),
    onRedoRetouch: () => void redoRetouch(),
    onRevertPage: () => void revertInpainting("page"),
    onRevertChapter: () => void revertInpainting("chapter"),
    onRunPage: () => void runInpainting("page"),
    onRunChapter: () => void runInpainting("chapter"),
    onRunDrawnPattern: () => void runDrawnPatternInpainting(),
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
    onPeekToggle: () => setPeekOriginal((value) => !value),
    onToggleChrome: () => setShowBlockChrome((value) => !value),
    onToggleBlocks: () => setShowTextBlocks((value) => !value),
    onExportResults: (scope) => void exportInpaintingResults(scope),
    onCancelJob: () => void window.mangaApi.cancelJob()
  };

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
        onWorkspaceWheel={onWorkspaceWheel}
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
          }
          setInpaintingGuideOpen(false);
        }}
      />
    </main>
    </FontsProvider>
  );
}

