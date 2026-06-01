import React, { useCallback, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  BBox,
  BlockType,
  ChapterSnapshot,
  ImportPreviewResult,
  InpaintingMaskStroke,
  JobState,
  LibraryIndex,
  MangaPage,
  TranslationBlock,
  WorkShareExportRequest,
  WorkShareImportPreview
} from "../../shared/types";
import {
  applyEditableBlockBbox,
  clampBbox,
  normalizeBlockType,
  normalizeRenderDirection,
  normalizeRotationDeg,
  offsetBlockBboxes,
  resolveEditableBlockBbox
} from "../../shared/geometry";
import { isUsableRegionBbox } from "../../shared/region";
import { AppSidebar } from "./components/AppSidebar";
import { AppWorkspace } from "./components/AppWorkspace";
import { ConfirmModal } from "./components/ConfirmModal";
import { EditorPanel } from "./components/EditorPanel";
import { InpaintingGuideModal } from "./components/InpaintingGuideModal";
import { ImportModal, type ImportModalSubmit } from "./components/ImportModal";
import {
  DisplayControlPanel,
  InpaintingControlPanel,
  type BlockCounts,
  type InpaintingStage,
  type InpaintingTool
} from "./components/InpaintingControlPanel";
import { RenameModal } from "./components/RenameModal";
import { RunPanel, StatusPanel } from "./components/RunStatusPanels";
import { SettingsModal } from "./components/SettingsModal";
import { ShareExportModal } from "./components/ShareExportModal";
import { ShareImportModal, type ShareImportModalSubmit } from "./components/ShareImportModal";
import { TranslateSourceModal, type TranslateSourceMode } from "./components/TranslateSourceModal";
import { useStageSize } from "./hooks/useStageSize";
import {
  formatErrorMessage,
  isEditableTarget,
  regionSelectionToBbox,
  reorderByTarget,
  reorderRecordsByIdOrder,
  resolveStatusLineReplacement,
  type RegionSelectionState
} from "./lib/appHelpers";
import { markChapterPagesRunning, mergeLiveChapterPreservingDirtyPages, resolveSelectionAfterChapterSync } from "./lib/chapterSync";
import { formatJobEventLine, formatJobLabel, resolveProgressSnapshot, summarizeWarnings, type ProgressSnapshot } from "./lib/jobProgress";
import { resolveAdjacentPageId, resolveKeyboardPageNavigation, resolveWheelPageNavigation } from "./lib/pageNavigation";
import "./styles.css";

const EMPTY_JOB: JobState = {
  id: "idle",
  kind: "gemma-analysis",
  status: "idle",
  progressText: "대기 중"
};

const PAGE_IMAGE_CACHE_LIMIT = 3;
const INPAINTING_GUIDE_HIDDEN_KEY = "mgt.inpaintingGuide.hidden";

type DragMode = "move" | "resize";

type DragState = {
  mode: DragMode;
  blockId: string;
  startX: number;
  startY: number;
  startBbox: BBox;
};

type RetouchPreviewState = {
  mode: "brush" | "eraser" | "mask";
  points: Array<{ x: number; y: number }>;
  radiusPx: number;
  color: string;
};
type RetouchHistoryEntry = {
  pageId: string;
  beforePath?: string;
  afterPath?: string;
};

type RenameTarget =
  | {
      kind: "work";
      id: string;
      title: string;
    }
  | {
      kind: "chapter";
      id: string;
      title: string;
    };

type ConfirmDialogState = {
  title: string;
  message: string;
  detail?: string;
};

export default function App(): React.JSX.Element {
  const [library, setLibrary] = useState<LibraryIndex>({ workOrder: [], works: [] });
  const [currentChapter, setCurrentChapter] = useState<ChapterSnapshot | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [selectedPageImageDataUrl, setSelectedPageImageDataUrl] = useState("");
  const [selectedPageOriginalImageDataUrl, setSelectedPageOriginalImageDataUrl] = useState("");
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [regionSelection, setRegionSelection] = useState<RegionSelectionState | null>(null);
  const [jobState, setJobState] = useState<JobState>(EMPTY_JOB);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [translationSourceOpen, setTranslationSourceOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [shareExportOpen, setShareExportOpen] = useState(false);
  const [shareExportBusy, setShareExportBusy] = useState(false);
  const [shareImportPreview, setShareImportPreview] = useState<WorkShareImportPreview | null>(null);
  const [shareImportBusy, setShareImportBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);
  const [inpaintingMode, setInpaintingMode] = useState(false);
  const [inpaintingStage, setInpaintingStage] = useState<InpaintingStage>("pattern");
  const [inpaintingHighlightType, setInpaintingHighlightType] = useState<BlockType | null>(null);
  const [inpaintingGuideOpen, setInpaintingGuideOpen] = useState(false);
  const [hideInpaintingGuide, setHideInpaintingGuide] = useState(() =>
    typeof window === "undefined" ? false : window.localStorage.getItem(INPAINTING_GUIDE_HIDDEN_KEY) === "1"
  );
  const [inpaintingTool, setInpaintingTool] = useState<InpaintingTool>("none");
  const [inpaintingBrushRadius, setInpaintingBrushRadius] = useState(28);
  const [inpaintingPaintColor, setInpaintingPaintColor] = useState("#ffffff");
  const [retouchCursorPoint, setRetouchCursorPoint] = useState<{ x: number; y: number } | null>(null);
  const [retouchPreview, setRetouchPreview] = useState<RetouchPreviewState | null>(null);
  const [patternMaskStrokes, setPatternMaskStrokes] = useState<InpaintingMaskStroke[]>([]);
  const [retouchUndoStack, setRetouchUndoStack] = useState<RetouchHistoryEntry[]>([]);
  const [retouchRedoStack, setRetouchRedoStack] = useState<RetouchHistoryEntry[]>([]);
  const [showBlockChrome, setShowBlockChrome] = useState(true);
  const [showTextBlocks, setShowTextBlocks] = useState(true);
  const workspacePanelRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const lastWheelNavigationAtRef = useRef(0);
  const dirtyVersionRef = useRef(0);
  const dirtyPageIdsRef = useRef<Set<string>>(new Set());
  const currentChapterRef = useRef<ChapterSnapshot | null>(null);
  const selectedPageIdRef = useRef<string | null>(null);
  const selectedBlockIdRef = useRef<string | null>(null);
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const pageImageCacheRef = useRef<Map<string, string>>(new Map());
  const inpaintingRetouchDrawingRef = useRef(false);
  const inpaintingRetouchPointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const lastInpaintingRetouchPointRef = useRef<{ x: number; y: number } | null>(null);
  const patternMaskStrokesRef = useRef<InpaintingMaskStroke[]>([]);
  const retouchUndoStackRef = useRef<RetouchHistoryEntry[]>([]);
  const retouchRedoStackRef = useRef<RetouchHistoryEntry[]>([]);

  const selectedPage = useMemo(
    () => currentChapter?.pages.find((page) => page.id === selectedPageId) ?? currentChapter?.pages[0] ?? null,
    [currentChapter?.pages, selectedPageId]
  );
  const selectedPageImagePath = selectedPage?.inpaintedImagePath ?? selectedPage?.imagePath ?? null;
  const selectedBlock = selectedPage?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const jobActive = ["starting", "running", "cancelling"].includes(jobState.status);
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
  const blockCounts = useMemo(() => countChapterBlocks(currentChapter), [currentChapter]);
  const inpaintedPageCount = useMemo(
    () => currentChapter?.pages.filter((page) => Boolean(page.inpaintedImagePath)).length ?? 0,
    [currentChapter?.pages]
  );
  const inpaintingToolActive = inpaintingMode && inpaintingStage !== "review" && inpaintingTool !== "none";
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
  const refreshLibrary = useCallback(async () => {
    const next = await window.mangaApi.getLibrary();
    setLibrary(next);
  }, []);

  const refreshSettings = useCallback(async () => {
    const next = await window.mangaApi.getSettings();
    setSettings(next);
    return next;
  }, []);

  React.useEffect(() => {
    void refreshLibrary();
  }, [refreshLibrary]);

  React.useEffect(() => {
    void refreshSettings().catch((error) => {
      console.error(error);
    });
  }, [refreshSettings]);

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
    retouchUndoStackRef.current = retouchUndoStack;
  }, [retouchUndoStack]);

  React.useEffect(() => {
    retouchRedoStackRef.current = retouchRedoStack;
  }, [retouchRedoStack]);

  React.useEffect(() => {
    patternMaskStrokesRef.current = patternMaskStrokes;
  }, [patternMaskStrokes]);

  React.useEffect(() => {
    setRegionSelection(null);
    setPatternMaskStrokes([]);
  }, [selectedPage?.id]);

  React.useEffect(() => {
    if (!currentChapter) {
      setInpaintingMode(false);
      setInpaintingStage("pattern");
      setInpaintingHighlightType(null);
      setInpaintingGuideOpen(false);
      setPatternMaskStrokes([]);
    }
  }, [currentChapter]);

  React.useEffect(() => {
    pageImageCacheRef.current.clear();
    setSelectedPageImageDataUrl("");
    setRetouchUndoStack([]);
    setRetouchRedoStack([]);
  }, [currentChapter?.id]);

  React.useEffect(() => {
    if (!selectedPage) {
      setSelectedPageImageDataUrl("");
      setSelectedPageOriginalImageDataUrl("");
      setRetouchCursorPoint(null);
      setRetouchPreview(null);
      return;
    }

    const imagePath = selectedPageImagePath ?? selectedPage.imagePath;
    const cacheKey = `${selectedPage.id}:${imagePath}`;
    const cached = pageImageCacheRef.current.get(cacheKey);
    if (cached) {
      setSelectedPageImageDataUrl(cached);
      return;
    }

    let cancelled = false;
    setSelectedPageImageDataUrl("");
    void window.mangaApi
      .getPageImageDataUrl(imagePath)
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        const cache = pageImageCacheRef.current;
        cache.delete(cacheKey);
        cache.set(cacheKey, dataUrl);
        while (cache.size > PAGE_IMAGE_CACHE_LIMIT) {
          const oldestPageId = cache.keys().next().value;
          if (!oldestPageId) {
            break;
          }
          cache.delete(oldestPageId);
        }
        setSelectedPageImageDataUrl(dataUrl);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(error);
          setSelectedPageImageDataUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPage?.id, selectedPageImagePath]);

  React.useEffect(() => {
    if (!selectedPage) {
      setSelectedPageOriginalImageDataUrl("");
      return;
    }
    if (selectedPageImagePath === selectedPage.imagePath && selectedPageImageDataUrl) {
      setSelectedPageOriginalImageDataUrl(selectedPageImageDataUrl);
      return;
    }

    const imagePath = selectedPage.imagePath;
    const cacheKey = `${selectedPage.id}:original:${imagePath}`;
    const cached = pageImageCacheRef.current.get(cacheKey);
    if (cached) {
      setSelectedPageOriginalImageDataUrl(cached);
      return;
    }

    let cancelled = false;
    setSelectedPageOriginalImageDataUrl("");
    void window.mangaApi
      .getPageImageDataUrl(imagePath)
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        const cache = pageImageCacheRef.current;
        cache.delete(cacheKey);
        cache.set(cacheKey, dataUrl);
        while (cache.size > PAGE_IMAGE_CACHE_LIMIT) {
          const oldestPageId = cache.keys().next().value;
          if (!oldestPageId) {
            break;
          }
          cache.delete(oldestPageId);
        }
        setSelectedPageOriginalImageDataUrl(dataUrl);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(error);
          setSelectedPageOriginalImageDataUrl("");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPage?.id, selectedPage?.imagePath, selectedPageImageDataUrl, selectedPageImagePath]);

  React.useEffect(() => {
    if (!inpaintingToolActive) {
      setRetouchCursorPoint(null);
      setRetouchPreview(null);
    }
  }, [inpaintingToolActive]);

  const mergeLiveChapter = useCallback((chapter: ChapterSnapshot) => {
    const current = currentChapterRef.current;
    if (current && current.id !== chapter.id) {
      return;
    }

    const mergeResult = mergeLiveChapterPreservingDirtyPages(chapter, current, dirtyPageIdsRef.current);
    dirtyPageIdsRef.current = new Set(mergeResult.preservedDirtyPageIds);
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
    setDirty(mergeResult.preservedDirtyPageIds.length > 0);
  }, []);

  const appendStatusLine = useCallback((line: string, replaceExisting?: (line: string) => boolean) => {
    const next = line.trim();
    if (!next) {
      return;
    }
    setStatusLines((lines) => {
      if (lines[0] === next) {
        return lines;
      }
      const remaining = replaceExisting ? lines.filter((line) => !replaceExisting(line)) : lines;
      return [next, ...remaining].slice(0, 16);
    });
  }, []);

  React.useEffect(() => {
    const unsubscribe = window.mangaApi.onJobEvent((event) => {
      setJobState((current) => {
        const sameJob = current.id === event.id;
        const logOnlyEvent = Boolean(event.installLogLine && event.progressMode === "log-only");
        const preserveCurrentStatus = sameJob && logOnlyEvent;
        const friendlyText = preserveCurrentStatus ? current.progressText : formatJobLabel(event);
        const preserveExactProgress = Boolean(event.installLogLine && sameJob && event.progressMode !== "log-only");
        return {
          id: event.id,
          kind: preserveCurrentStatus ? current.kind : event.kind,
          status: preserveCurrentStatus ? current.status : event.status,
          progressText: friendlyText,
          detail: preserveCurrentStatus ? current.detail : event.detail ?? current.detail,
          phase: preserveCurrentStatus ? current.phase : event.phase ?? current.phase,
          progressMode: preserveCurrentStatus ? current.progressMode : event.progressMode ?? (event.installLogLine && sameJob ? current.progressMode : undefined),
          progressPercent: preserveCurrentStatus ? current.progressPercent : event.progressPercent ?? (preserveExactProgress ? current.progressPercent : undefined),
          progressBytes: preserveCurrentStatus ? current.progressBytes : event.progressBytes ?? (preserveExactProgress ? current.progressBytes : undefined),
          progressTotalBytes: preserveCurrentStatus ? current.progressTotalBytes : event.progressTotalBytes ?? (preserveExactProgress ? current.progressTotalBytes : undefined),
          progressBytesPerSecond: preserveCurrentStatus
            ? current.progressBytesPerSecond
            : event.progressBytesPerSecond ?? (preserveExactProgress ? current.progressBytesPerSecond : undefined),
          installLogLine: event.installLogLine,
          installLogLines: event.installLogLine
            ? [...(sameJob ? current.installLogLines ?? [] : []), event.installLogLine].slice(-80)
            : sameJob
              ? current.installLogLines
              : undefined,
          progressCurrent: preserveCurrentStatus ? current.progressCurrent : event.progressCurrent ?? current.progressCurrent,
          progressTotal: preserveCurrentStatus ? current.progressTotal : event.progressTotal ?? current.progressTotal,
          pageIndex: preserveCurrentStatus ? current.pageIndex : event.pageIndex ?? current.pageIndex,
          pageTotal: preserveCurrentStatus ? current.pageTotal : event.pageTotal ?? current.pageTotal,
          attempt: preserveCurrentStatus ? current.attempt : event.attempt ?? current.attempt,
          attemptTotal: preserveCurrentStatus ? current.attemptTotal : event.attemptTotal ?? current.attemptTotal
        };
      });
      if (!(event.installLogLine && event.progressMode === "log-only")) {
        appendStatusLine(formatJobEventLine(event), resolveStatusLineReplacement(event));
      }

      if (event.phase === "page_done" || event.phase === "page_skipped") {
        const chapterId = currentChapterRef.current?.id;
        if (!chapterId) {
          return;
        }

        void window.mangaApi
          .openChapter(chapterId)
          .then((chapter) => {
            if (currentChapterRef.current?.id === chapter.id) {
              mergeLiveChapter(chapter);
            }
          })
          .then(() => refreshLibrary())
          .catch((error) => {
            console.error(error);
          });
      }
    });
    return unsubscribe;
  }, [appendStatusLine, mergeLiveChapter, refreshLibrary]);

  React.useEffect(() => {
    if (!dirty || !currentChapter || jobActive) {
      return;
    }

    const version = dirtyVersionRef.current;
    saveTimerRef.current = window.setTimeout(async () => {
      try {
        await window.mangaApi.saveChapter(currentChapter);
        if (dirtyVersionRef.current === version) {
          dirtyPageIdsRef.current.clear();
          setDirty(false);
        }
      } catch (error) {
        console.error(error);
      } finally {
        saveTimerRef.current = null;
      }
    }, 400);

    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [currentChapter, dirty, jobActive]);

  const pushStatus = useCallback(
    (line: string) => {
      void window.mangaApi.writeLog("info", "UI status", { line });
      appendStatusLine(line);
    },
    [appendStatusLine]
  );

  const resolveConfirmDialog = useCallback((confirmed: boolean) => {
    const resolver = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmDialog(null);
    resolver?.(confirmed);
  }, []);

  const askConfirm = useCallback((title: string, message: string, detail?: string) => {
    confirmResolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      confirmResolverRef.current = resolve;
      setConfirmDialog({ title, message, detail });
    });
  }, []);

  const markDirty = useCallback((pageId?: string) => {
    dirtyVersionRef.current += 1;
    if (pageId) {
      dirtyPageIdsRef.current = new Set([...dirtyPageIdsRef.current, pageId]);
    }
    setDirty(true);
  }, []);

  const saveNow = useCallback(async () => {
    if (!currentChapter) {
      return;
    }
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await window.mangaApi.saveChapter(currentChapter);
    dirtyPageIdsRef.current.clear();
    setDirty(false);
  }, [currentChapter]);

  const clearCurrentChapter = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setCurrentChapter(null);
    currentChapterRef.current = null;
    setSelectedPageId(null);
    setSelectedBlockId(null);
    dirtyPageIdsRef.current.clear();
    setDirty(false);
  }, []);

  const openChapter = useCallback(
    async (chapterId: string) => {
      if (dirty) {
        await saveNow();
      }
      const chapter = await window.mangaApi.openChapter(chapterId);
      dirtyPageIdsRef.current.clear();
      currentChapterRef.current = chapter;
      setCurrentChapter(chapter);
      setSelectedPageId(chapter.pages[0]?.id ?? null);
      setSelectedBlockId(null);
      setDirty(false);
    },
    [dirty, saveNow]
  );

  const applyChapter = useCallback((chapter: ChapterSnapshot | undefined, fallbackStatus?: string) => {
    if (!chapter) {
      return;
    }
    dirtyPageIdsRef.current.clear();
    currentChapterRef.current = chapter;
    setCurrentChapter(chapter);
    setSelectedPageId((current) => (chapter.pages.some((page) => page.id === current) ? current : chapter.pages[0]?.id ?? null));
    setSelectedBlockId(null);
    setDirty(false);
    if (fallbackStatus) {
      pushStatus(fallbackStatus);
    }
  }, [pushStatus]);

  const selectPageForReading = useCallback((pageId: string | null) => {
    if (!pageId) {
      return;
    }
    selectedPageIdRef.current = pageId;
    selectedBlockIdRef.current = null;
    setSelectedPageId(pageId);
    setSelectedBlockId(null);
  }, []);

  const selectAdjacentPageForReading = useCallback(
    (direction: "previous" | "next") => {
      const chapter = currentChapterRef.current;
      const pageIds = chapter?.pages.map((page) => page.id) ?? [];
      const nextPageId = resolveAdjacentPageId(pageIds, selectedPageIdRef.current, direction);
      if (!nextPageId) {
        return false;
      }

      selectPageForReading(nextPageId);
      return true;
    },
    [selectPageForReading]
  );

  const openImportPreview = useCallback(async (mode: "images" | "folder" | "zip" | "zip-folder") => {
    const preview =
      mode === "images"
        ? await window.mangaApi.previewImagesImport()
        : mode === "folder"
          ? await window.mangaApi.previewFolderImport()
          : mode === "zip"
            ? await window.mangaApi.previewZipImport()
            : await window.mangaApi.previewZipFolderImport();
    if (!preview) {
      return;
    }
    setImportPreview(preview);
  }, []);

  const selectTranslateSource = useCallback(
    async (mode: TranslateSourceMode) => {
      setTranslationSourceOpen(false);
      await openImportPreview(mode);
    },
    [openImportPreview]
  );

  const submitShareExport = useCallback(
    async (request: WorkShareExportRequest) => {
      setShareExportBusy(true);
      try {
        if (dirty) {
          await saveNow();
        }
        const result = await window.mangaApi.exportWorkShare(request);
        if (result) {
          pushStatus(`${result.workTitle} 공유 파일을 저장했습니다. ${result.chapterCount}개 화, ${result.pageCount}페이지`);
          setShareExportOpen(false);
        }
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, "공유 파일을 저장하지 못했습니다."));
      } finally {
        setShareExportBusy(false);
      }
    },
    [dirty, pushStatus, saveNow]
  );

  const openShareImportPreview = useCallback(async () => {
    try {
      if (dirty) {
        await saveNow();
      }
      const preview = await window.mangaApi.previewWorkShareImport();
      if (preview) {
        setShareImportPreview(preview);
      }
    } catch (error) {
      console.error(error);
      pushStatus(formatErrorMessage(error, "공유 파일을 읽지 못했습니다."));
    }
  }, [dirty, pushStatus, saveNow]);

  const submitShareImport = useCallback(
    async (payload: ShareImportModalSubmit) => {
      if (!shareImportPreview) {
        return;
      }

      if (payload.remainingPackageChapters.length > 0) {
        const confirmed = await askConfirm(
          "가져오지 않는 화가 있습니다",
          "오른쪽에 남은 공유 화는 적용되지 않습니다.",
          payload.remainingPackageChapters.map((chapter) => chapter.title).join("\n")
        );
        if (!confirmed) {
          return;
        }
      }

      if (payload.deletedExistingChapters.length > 0) {
        const confirmed = await askConfirm(
          "기존 화 삭제",
          "왼쪽 최종 목록에서 빠진 기존 화가 보관함에서 삭제됩니다.",
          payload.deletedExistingChapters.map((chapter) => chapter.title).join("\n")
        );
        if (!confirmed) {
          return;
        }
      }

      setShareImportBusy(true);
      try {
        if (dirty) {
          await saveNow();
        }
        const result = await window.mangaApi.importWorkShare({
          packagePath: shareImportPreview.packagePath,
          target: payload.target,
          entries: payload.entries
        });
        await refreshLibrary();
        applyChapter(result.openedChapter, `${result.chapterIds.length}개 화를 보관함에 적용했습니다.`);
        setShareImportPreview(null);
      } catch (error) {
        console.error(error);
        pushStatus(formatErrorMessage(error, "공유 파일을 가져오지 못했습니다."));
      } finally {
        setShareImportBusy(false);
      }
    },
    [applyChapter, askConfirm, dirty, pushStatus, refreshLibrary, saveNow, shareImportPreview]
  );

  const runAnalysis = useCallback(
    async (runMode: "pending" | "all" | "single-page", pageId?: string) => {
      if (!currentChapter || jobActive) {
        return;
      }

      await saveNow();
      setStatusLines([]);
      setJobState({
        id: "pending",
        kind: "gemma-analysis",
        status: "starting",
        progressText: "모델 준비 중",
        phase: "booting"
      });
      setCurrentChapter((chapter) => (chapter ? markChapterPagesRunning(chapter, runMode, pageId) : chapter));

      const result = await window.mangaApi.startAnalysis({ chapterId: currentChapter.id, runMode, pageId });
      if (result.chapter) {
        mergeLiveChapter(result.chapter);
      }
      await refreshLibrary();

      if (result.status === "completed") {
        const warningSummary = summarizeWarnings(result.warnings ?? []);
        if (warningSummary) {
          pushStatus(warningSummary);
        }
        return;
      }

      if (result.status === "failed" && result.error) {
        pushStatus(result.error);
      }
    },
    [currentChapter, jobActive, mergeLiveChapter, pushStatus, refreshLibrary, saveNow]
  );

  const enterInpaintingMode = useCallback(async () => {
    if (!currentChapter || jobActive) {
      return;
    }
    if (dirty) {
      await saveNow();
    }
    setInpaintingMode(true);
    setInpaintingStage("pattern");
    setInpaintingTool("none");
    setInpaintingHighlightType(null);
    setSelectedBlockId(null);
    setRegionSelection(null);
    setShowBlockChrome(true);
    setShowTextBlocks(true);
    if (!hideInpaintingGuide) {
      setInpaintingGuideOpen(true);
    }
    pushStatus("인페인팅 모드로 전환했습니다. 무늬 배경 지우기부터 시작하세요.");
  }, [currentChapter, dirty, hideInpaintingGuide, jobActive, pushStatus, saveNow]);

  const exitInpaintingMode = useCallback(() => {
    if (jobActive) {
      return;
    }
    setInpaintingMode(false);
    setInpaintingStage("pattern");
    setInpaintingTool("none");
    setInpaintingHighlightType(null);
    setInpaintingGuideOpen(false);
    setPatternMaskStrokes([]);
    setSelectedBlockId(null);
    setRegionSelection(null);
    pushStatus("인페인팅 모드를 종료했습니다.");
  }, [jobActive, pushStatus]);

  const runInpainting = useCallback(
    async (scope: "page" | "chapter") => {
      if (!currentChapter || jobActive || inpaintingStage === "review") {
        return;
      }
      if (scope === "page" && !selectedPage) {
        return;
      }
      if (dirty) {
        await saveNow();
      }
      const targetLabel = "무늬 배경";
      const scopeLabel = scope === "page" ? "현재 페이지" : "전체 페이지";
      const confirmed = await askConfirm(
        `${targetLabel} 원문 지우기`,
        `${scopeLabel}의 ${targetLabel} 블록을 지웁니다.`,
        "말풍선, 톤, 배경 그림, 효과음 위 글자까지 모두 Flux 인페인팅으로 지웁니다. 원본 이미지는 유지하고 결과 이미지는 별도로 저장합니다."
      );
      if (!confirmed) {
        return;
      }

      setJobState({
        id: "pending-inpainting",
        kind: "inpainting",
        status: "starting",
        progressText: `${targetLabel} 지우기 준비 중`,
        phase: "inpainting_preparing"
      });

      const result = await window.mangaApi.startInpainting(
        scope === "page"
          ? {
              chapterId: currentChapter.id,
              mode: "page-pattern",
              pageId: selectedPage!.id
            }
          : {
              chapterId: currentChapter.id,
              mode: "chapter-pattern"
            }
      );
      if (result.chapter) {
        pageImageCacheRef.current.clear();
        mergeLiveChapter(result.chapter);
      }
      await refreshLibrary();

      if (result.status === "completed") {
        pushStatus(`${targetLabel} 지우기 완료: ${result.pagesChanged ?? 0}페이지, ${result.blocksErased ?? 0}블록`);
      } else if (result.status === "failed" && result.error) {
        pushStatus(result.error);
      }
    },
    [askConfirm, currentChapter, dirty, inpaintingStage, jobActive, mergeLiveChapter, pushStatus, refreshLibrary, saveNow, selectedPage]
  );

  const runDrawnPatternInpainting = useCallback(async () => {
    if (!currentChapter || !selectedPage || jobActive || patternMaskStrokes.length === 0) {
      return;
    }
    if (dirty) {
      await saveNow();
    }
    const confirmed = await askConfirm(
      "그린 영역 지우기",
      "주황색으로 그린 마스크 영역만 Flux로 지웁니다.",
      "글자 위를 넉넉히 문질러 둔 영역을 crop으로 잘라 무늬 배경을 복원합니다. 결과는 별도 이미지로 저장되며 원본 페이지는 유지됩니다."
    );
    if (!confirmed) {
      return;
    }
    setJobState({
      id: "pending-inpainting",
      kind: "inpainting",
      status: "starting",
      progressText: "그린 영역 지우기 준비 중",
      phase: "inpainting_preparing",
      progressCurrent: 0,
      progressTotal: 1
    });
    const result = await window.mangaApi.startInpainting({
      chapterId: currentChapter.id,
      mode: "page-pattern-drawn",
      pageId: selectedPage.id,
      strokes: patternMaskStrokes,
      featherPx: 8
    });
    if (result.chapter) {
      pageImageCacheRef.current.clear();
      mergeLiveChapter(result.chapter);
    }
    await refreshLibrary();
    if (result.status === "completed") {
      setPatternMaskStrokes([]);
      pushStatus(`그린 영역 지우기 완료: ${result.pagesChanged ?? 0}페이지, ${result.blocksErased ?? 0}영역`);
    } else if (result.status === "failed" && result.error) {
      pushStatus(result.error);
    }
  }, [
    askConfirm,
    currentChapter,
    dirty,
    jobActive,
    mergeLiveChapter,
    patternMaskStrokes,
    pushStatus,
    refreshLibrary,
    saveNow,
    selectedPage
  ]);

  const exportInpaintingResults = useCallback(async () => {
    if (!currentChapter || jobActive) {
      return;
    }
    if (dirty) {
      await saveNow();
    }
    try {
      const result = await window.mangaApi.exportInpaintingResults({ chapterId: currentChapter.id });
      pushStatus(`인페인팅 결과를 PNG로 출력했습니다: ${result.pageCount}페이지`);
    } catch (error) {
      console.error(error);
      pushStatus(formatErrorMessage(error, "인페인팅 결과를 출력하지 못했습니다."));
    }
  }, [currentChapter, dirty, jobActive, pushStatus, saveNow]);

  const goToNextInpaintingStage = useCallback(async () => {
    if (jobActive) {
      return;
    }
    if (inpaintingStage === "pattern") {
      if (inpaintedPageCount === 0 && blockCounts.total > 0) {
        const confirmed = await askConfirm(
          "원문 지우기 건너뛰기",
          "아직 인페인팅을 실행하지 않았습니다.",
          "지우기 없이 최종 처리 단계로 넘어가면 원문이 남아 있을 수 있습니다. 그래도 넘어갈까요?"
        );
        if (!confirmed) {
          return;
        }
      }
      setInpaintingStage("finalize");
      setInpaintingHighlightType(null);
      setShowTextBlocks(true);
      setShowBlockChrome(true);
      setPatternMaskStrokes([]);
      pushStatus("최종 처리 단계로 이동했습니다.");
      return;
    }
    if (inpaintingStage === "finalize") {
      setInpaintingStage("review");
      setInpaintingHighlightType(null);
      pushStatus("결과 확인 단계로 이동했습니다.");
    }
  }, [askConfirm, blockCounts.total, inpaintedPageCount, inpaintingStage, jobActive, pushStatus]);

  const goToPreviousInpaintingStage = useCallback(() => {
    if (jobActive) {
      return;
    }
    if (inpaintingStage === "finalize") {
      setInpaintingStage("pattern");
      setInpaintingHighlightType(null);
      setShowTextBlocks(true);
      setShowBlockChrome(true);
      pushStatus("무늬 배경 단계로 돌아왔습니다.");
      return;
    }
    if (inpaintingStage === "review") {
      setInpaintingStage("finalize");
      setInpaintingHighlightType(null);
      setShowTextBlocks(true);
      setShowBlockChrome(true);
      pushStatus("최종 처리 단계로 돌아왔습니다.");
    }
  }, [inpaintingStage, jobActive, pushStatus]);

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
    setRegionSelection({
      active: true,
      dragging: false,
      start: { x: 0, y: 0 },
      current: { x: 0, y: 0 }
    });
    pushStatus("번역할 영역을 드래그하세요.");
  }, [jobActive, pushStatus, regionSelection?.active, selectedPage, selectedPageImageDataUrl]);

  const translateSelectedRegion = useCallback(
    async (bbox: BBox) => {
      if (!currentChapter || !selectedPage || jobActive) {
        return;
      }
      if (!isUsableRegionBbox(bbox, 10)) {
        pushStatus("선택 영역이 너무 작습니다.");
        return;
      }

      await saveNow();
      setStatusLines([]);
      setJobState({
        id: "pending",
        kind: "gemma-analysis",
        status: "starting",
        progressText: "선택 영역 번역 준비 중",
        phase: "booting",
        progressCurrent: 0,
        progressTotal: 1,
        pageIndex: 1,
        pageTotal: 1
      });

      const result = await window.mangaApi.translateRegion({
        chapterId: currentChapter.id,
        pageId: selectedPage.id,
        bbox
      });
      if (result.chapter) {
        mergeLiveChapter(result.chapter);
      }
      await refreshLibrary();

      if (result.status === "completed") {
        if (result.blockIds?.[0]) {
          setSelectedBlockId(result.blockIds[0]);
        }
        const warningSummary = summarizeWarnings(result.warnings ?? []);
        pushStatus(warningSummary || `선택 영역에서 ${result.blockIds?.length ?? 0}개 블록을 만들었습니다.`);
        return;
      }

      if (result.status === "failed" && result.error) {
        pushStatus(result.error);
      }
    },
    [currentChapter, jobActive, mergeLiveChapter, pushStatus, refreshLibrary, saveNow, selectedPage]
  );

  const submitImport = useCallback(
    async ({ target, selections }: ImportModalSubmit) => {
      if (!importPreview) {
        return;
      }

      setImportBusy(true);
      try {
        const result = await window.mangaApi.createImport({
          preview: importPreview,
          target,
          selections
        });
        await refreshLibrary();
        applyChapter(result.openedChapter, `${result.chapterIds.length}개 화를 보관함에 추가했습니다.`);
        setImportPreview(null);

        if (importPreview.mode === "batch") {
          for (const chapterId of result.chapterIds) {
            await openChapter(chapterId);
            const runResult = await window.mangaApi.startAnalysis({ chapterId, runMode: "pending" });
            if (runResult.chapter) {
              mergeLiveChapter(runResult.chapter);
            }
            await refreshLibrary();
            if (runResult.status !== "completed") {
              break;
            }
          }
        }
      } finally {
        setImportBusy(false);
      }
    },
    [applyChapter, importPreview, mergeLiveChapter, openChapter, refreshLibrary]
  );

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

  const updateSelectedBlock = (patch: Partial<TranslationBlock>) => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
      return;
    }

    updateCurrentChapter(selectedPage.id, (current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id !== selectedPage.id
          ? page
          : {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: page.blocks.map((block) => {
                if (block.id !== selectedBlock.id) {
                  return block;
                }

                const nextType = normalizeBlockType(patch.type ?? block.type);
                const nextRenderDirection = normalizeRenderDirection(patch.renderDirection ?? block.renderDirection, block.renderDirection);
                return {
                  ...block,
                  ...patch,
                  type: nextType,
                  renderDirection: nextRenderDirection,
                  rotationDeg: normalizeRotationDeg(patch.rotationDeg ?? block.rotationDeg ?? 0),
                  backgroundColor: patch.backgroundColor ?? block.backgroundColor,
                  opacity: patch.opacity ?? block.opacity,
                  bbox: patch.bbox ? clampBbox(patch.bbox) : block.bbox,
                  bboxSpace: patch.bbox ? "normalized_1000" : block.bboxSpace,
                  renderBbox: patch.renderBbox ? clampBbox(patch.renderBbox) : block.renderBbox,
                  renderBboxSpace: patch.renderBbox ? "normalized_1000" : block.renderBboxSpace
                };
              })
            }
      )
    }));
  };

  const deleteSelectedBlock = () => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
      return;
    }
    updateCurrentChapter(selectedPage.id, (current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: page.blocks.filter((block) => block.id !== selectedBlock.id)
            }
          : page
      )
    }));
    setSelectedBlockId(null);
  };

  const duplicateSelectedBlock = () => {
    if (!selectedPage || !selectedBlock || selectedPageEditLocked) {
      return;
    }
    const copy = {
      ...offsetBlockBboxes(selectedBlock, 16, 16, { width: selectedPage.width, height: selectedPage.height }),
      id: `${selectedBlock.id}-copy-${Date.now()}`
    };
    updateCurrentChapter(selectedPage.id, (current) => ({
      ...current,
      pages: current.pages.map((page) =>
        page.id === selectedPage.id
          ? {
              ...page,
              updatedAt: new Date().toISOString(),
              blocks: [...page.blocks, copy]
            }
          : page
      )
    }));
    setSelectedBlockId(copy.id);
  };

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

  const appendRetouchPoint = useCallback(
    (point: { x: number; y: number }, tool?: Extract<InpaintingTool, "brush" | "eraser" | "mask">) => {
      const last = lastInpaintingRetouchPointRef.current;
      const minDistance = Math.max(2, inpaintingBrushRadius * 0.2);
      if (last) {
        const dx = point.x - last.x;
        const dy = point.y - last.y;
        if (Math.sqrt(dx * dx + dy * dy) < minDistance) {
          return;
        }
      }
      lastInpaintingRetouchPointRef.current = point;
      inpaintingRetouchPointsRef.current.push({
        x: Math.round(point.x),
        y: Math.round(point.y)
      });
      if (tool) {
        const nextPoint = { x: Math.round(point.x), y: Math.round(point.y) };
        setRetouchPreview((current) => {
          if (!current || current.mode !== tool) {
            return {
              mode: tool,
              points: [nextPoint],
              radiusPx: inpaintingBrushRadius,
              color: tool === "mask" ? "#ff9f1c" : inpaintingPaintColor
            };
          }
          return {
            ...current,
            radiusPx: inpaintingBrushRadius,
            color: tool === "mask" ? "#ff9f1c" : inpaintingPaintColor,
            points: [...current.points, nextPoint].slice(-1200)
          };
        });
      }
    },
    [inpaintingBrushRadius, inpaintingPaintColor]
  );

  const saveChapterWithInpaintPath = useCallback(
    async (pageId: string, inpaintedImagePath?: string) => {
      const chapter = currentChapterRef.current;
      if (!chapter) {
        return null;
      }
      const nextChapter: ChapterSnapshot = {
        ...chapter,
        pages: chapter.pages.map((page) =>
          page.id === pageId
            ? {
                ...page,
                inpaintedImagePath,
                updatedAt: new Date().toISOString()
              }
            : page
        )
      };
      pageImageCacheRef.current.clear();
      setCurrentChapter(nextChapter);
      currentChapterRef.current = nextChapter;
      const saved = await window.mangaApi.saveChapter(nextChapter);
      mergeLiveChapter(saved);
      return saved;
    },
    [mergeLiveChapter]
  );

  const applyRetouchPoints = useCallback(
    async (tool: Extract<InpaintingTool, "brush" | "eraser">, points: Array<{ x: number; y: number }>) => {
      if (!currentChapter || !selectedPage || points.length === 0 || jobActive) {
        return;
      }
      const beforePath = selectedPage.inpaintedImagePath;
      try {
        const result = await window.mangaApi.applyInpaintingRetouch({
          chapterId: currentChapter.id,
          pageId: selectedPage.id,
          mode: tool === "brush" ? "paint" : "restore",
          points,
          radiusPx: inpaintingBrushRadius,
          color: inpaintingPaintColor
        });
        const afterPage = result.chapter.pages.find((page) => page.id === selectedPage.id);
        pageImageCacheRef.current.clear();
        mergeLiveChapter(result.chapter);
        const afterPath = afterPage?.inpaintedImagePath;
        if (afterPath !== beforePath) {
          setRetouchUndoStack((stack) => [...stack, { pageId: selectedPage.id, beforePath, afterPath }].slice(-60));
          setRetouchRedoStack([]);
        }
      } catch (error) {
        console.error(error);
        pushStatus("리터치 적용에 실패했습니다.");
      }
    },
    [currentChapter, inpaintingBrushRadius, inpaintingPaintColor, jobActive, mergeLiveChapter, pushStatus, selectedPage]
  );

  const undoRetouch = useCallback(async () => {
    const entry = retouchUndoStackRef.current[retouchUndoStackRef.current.length - 1];
    if (!entry || jobActive) {
      return;
    }
    setRetouchUndoStack((stack) => stack.slice(0, -1));
    await saveChapterWithInpaintPath(entry.pageId, entry.beforePath);
    setRetouchRedoStack((stack) => [...stack, entry].slice(-60));
    pushStatus("리터치를 되돌렸습니다.");
  }, [jobActive, pushStatus, saveChapterWithInpaintPath]);

  const redoRetouch = useCallback(async () => {
    const entry = retouchRedoStackRef.current[retouchRedoStackRef.current.length - 1];
    if (!entry || jobActive) {
      return;
    }
    setRetouchRedoStack((stack) => stack.slice(0, -1));
    await saveChapterWithInpaintPath(entry.pageId, entry.afterPath);
    setRetouchUndoStack((stack) => [...stack, entry].slice(-60));
    pushStatus("리터치를 다시 적용했습니다.");
  }, [jobActive, pushStatus, saveChapterWithInpaintPath]);

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
      pageImageCacheRef.current.clear();
      mergeLiveChapter(result.chapter);
      setRetouchUndoStack([]);
      setRetouchRedoStack([]);
      pushStatus(`인페인팅 되돌리기 완료: ${result.pagesChanged}페이지`);
    },
    [askConfirm, currentChapter, jobActive, mergeLiveChapter, pushStatus, selectedPage]
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
              setInpaintingTool("brush");
              pushStatus(`붓 색상을 ${result.color}로 선택했습니다.`);
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
        setPatternMaskStrokes((strokes) => [...strokes, { points, radiusPx: inpaintingBrushRadius }].slice(-200));
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

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const pageIds = currentChapterRef.current?.pages.map((page) => page.id) ?? [];
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;
      const editableTarget = isEditableTarget(event.target);
      if (inpaintingMode && !modalOpen && !editableTarget && (event.ctrlKey || event.metaKey)) {
        const key = event.key.toLowerCase();
        if (key === "z" && !event.shiftKey) {
          event.preventDefault();
          void undoRetouch();
          return;
        }
        if (key === "y" || (key === "z" && event.shiftKey)) {
          event.preventDefault();
          void redoRetouch();
          return;
        }
      }
      const navigation = resolveKeyboardPageNavigation({
        key: event.key,
        hasPages: pageIds.length > 0,
        modalOpen,
        editableTarget,
        centerPanelFocused: Boolean(workspacePanelRef.current && activeElement && workspacePanelRef.current.contains(activeElement))
      });

      if (!navigation) {
        return;
      }

      if (!selectAdjacentPageForReading(navigation.direction)) {
        return;
      }

      if (navigation.preventDefault) {
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [inpaintingMode, modalOpen, redoRetouch, selectAdjacentPageForReading, undoRetouch]);

  const onWorkspaceWheel = useCallback(
    (event: React.WheelEvent<HTMLElement>) => {
      const pageIds = currentChapterRef.current?.pages.map((page) => page.id) ?? [];
      const direction = resolveWheelPageNavigation({
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        hasPages: pageIds.length > 0,
        modalOpen,
        editableTarget: isEditableTarget(event.target)
      });

      if (!direction) {
        return;
      }

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastWheelNavigationAtRef.current < 320) {
        event.preventDefault();
        return;
      }

      if (!selectAdjacentPageForReading(direction)) {
        return;
      }

      lastWheelNavigationAtRef.current = now;
      workspacePanelRef.current?.focus();
      event.preventDefault();
    },
    [modalOpen, selectAdjacentPageForReading]
  );

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

  const openSettings = useCallback(async () => {
    if (settings) {
      setSettingsOpen(true);
      return;
    }

    setSettingsBusy(true);
    try {
      await refreshSettings();
      setSettingsOpen(true);
    } catch (error) {
      console.error(error);
      pushStatus("설정을 불러오지 못했습니다.");
    } finally {
      setSettingsBusy(false);
    }
  }, [pushStatus, refreshSettings, settings]);

  const submitSettings = useCallback(async (nextSettings: AppSettings) => {
    setSettingsBusy(true);
    try {
      const saved = await window.mangaApi.saveSettings(nextSettings);
      setSettings(saved);
      setSettingsOpen(false);
      pushStatus("설정을 저장했습니다. 다음 번 번역 실행부터 적용됩니다.");
    } catch (error) {
      console.error(error);
      pushStatus("설정을 저장하지 못했습니다.");
    } finally {
      setSettingsBusy(false);
    }
  }, [pushStatus]);

  const resetSettings = useCallback(async () => {
    setSettingsBusy(true);
    try {
      const reset = await window.mangaApi.resetSettings();
      setSettings(reset);
      pushStatus("설정을 기본값으로 복원했습니다. 다음 번 번역 실행부터 적용됩니다.");
    } catch (error) {
      console.error(error);
      pushStatus("기본 설정을 복원하지 못했습니다.");
    } finally {
      setSettingsBusy(false);
    }
  }, [pushStatus]);

  const reorderChapterInLibrary = useCallback(
    (workId: string, sourceChapterId: string, targetChapterId: string) => {
      const work = library.works.find((candidate) => candidate.id === workId);
      if (!work) {
        return;
      }
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
      void window.mangaApi.reorderChapters(workId, nextOrder).then(setLibrary);
    },
    [library.works]
  );

  const reorderPageInChapter = useCallback(
    (sourcePageId: string, targetPageId: string) => {
      if (!currentChapter) {
        return;
      }
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
      void window.mangaApi.reorderPages(currentChapter.id, nextOrder).then((chapter) => {
        applyChapter(chapter);
        void refreshLibrary();
      });
    },
    [applyChapter, currentChapter, refreshLibrary]
  );

  return (
    <main className={`app-shell ${inpaintingMode ? "inpainting-mode" : ""}`}>
      <AppSidebar
        inpaintingMode={inpaintingMode}
        inpaintingStage={inpaintingStage}
        currentChapter={currentChapter}
        selectedPageId={selectedPage?.id ?? null}
        library={library}
        jobActive={jobActive}
        settingsBusy={settingsBusy}
        settingsOpen={settingsOpen}
        onExitInpainting={exitInpaintingMode}
        onPreviousInpaintingStage={goToPreviousInpaintingStage}
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
        selectedPageImageDataUrl={selectedPageImageDataUrl}
        imageRef={imageRef}
        stageRef={stageRef}
        stageSize={stageSize}
        selectedBlockId={selectedBlockId}
        showTextBlocks={showTextBlocks}
        showBlockChrome={showBlockChrome}
        inpaintingToolActive={inpaintingToolActive}
        inpaintingHighlightType={inpaintingHighlightType}
        retouchCursor={retouchCursor}
        retouchPreviewLayer={retouchPreviewLayer}
        maskStrokes={inpaintingMode && inpaintingStage === "pattern" ? patternMaskStrokes : []}
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
        onOpenTranslationSource={() => setTranslationSourceOpen(true)}
        onOpenBatchImport={() => void openImportPreview("zip-folder")}
        onOpenShareImport={() => void openShareImportPreview()}
      />

      <aside className={`right-rail ${inpaintingMode ? "inpainting-rail" : ""}`}>
        {inpaintingMode ? (
          <>
            <InpaintingControlPanel
              stage={inpaintingStage}
              currentChapter={currentChapter}
              selectedPage={selectedPage}
              selectedBlock={selectedBlock}
              blockCounts={blockCounts}
              inpaintedPageCount={inpaintedPageCount}
              tool={inpaintingTool}
              brushRadius={inpaintingBrushRadius}
              brushColor={inpaintingPaintColor}
              maskStrokeCount={patternMaskStrokes.length}
              canUndo={retouchUndoStack.length > 0}
              canRedo={retouchRedoStack.length > 0}
              jobState={jobState}
              progressSnapshot={progressSnapshot}
              showBlockChrome={showBlockChrome}
              showTextBlocks={showTextBlocks}
              jobActive={jobActive}
              onSelectTool={setInpaintingTool}
              onBrushRadiusChange={setInpaintingBrushRadius}
              onBrushColorChange={setInpaintingPaintColor}
              onUndoRetouch={() => void undoRetouch()}
              onRedoRetouch={() => void redoRetouch()}
              onRevertPage={() => void revertInpainting("page")}
              onRevertChapter={() => void revertInpainting("chapter")}
              onRunPage={() => void runInpainting("page")}
              onRunChapter={() => void runInpainting("chapter")}
              onRunDrawnPattern={() => void runDrawnPatternInpainting()}
              onClearPatternMask={() => setPatternMaskStrokes([])}
              onShowGuide={() => setInpaintingGuideOpen(true)}
              onToggleChrome={() => setShowBlockChrome((value) => !value)}
              onToggleBlocks={() => setShowTextBlocks((value) => !value)}
              onExportResults={() => void exportInpaintingResults()}
            />
            {inpaintingStage === "finalize" ? (
              <EditorPanel
                block={selectedBlock}
                disabled={selectedPageEditLocked || jobActive}
                onUpdate={updateSelectedBlock}
                onDelete={deleteSelectedBlock}
                onDuplicate={duplicateSelectedBlock}
              />
            ) : null}
            <section className="inpainting-next-panel">
              <button
                className={inpaintingStage === "pattern" ? "pattern-next-button" : "primary"}
                onClick={() => void goToNextInpaintingStage()}
                disabled={jobActive || inpaintingStage === "review"}
              >
                {inpaintingStage === "pattern" ? "최종 처리로 넘어가기" : inpaintingStage === "finalize" ? "결과 확인" : "완료"}
              </button>
            </section>
          </>
        ) : (
          <>
            <RunPanel
              currentChapter={currentChapter}
              jobActive={jobActive}
              showProgressBar={showProgressBar}
              progressSnapshot={progressSnapshot}
              jobState={jobState}
              onRunPending={() => void runAnalysis("pending")}
              onRunAll={() => void runAnalysis("all")}
              onEnterInpainting={() => void enterInpaintingMode()}
              onCancelJob={() => void window.mangaApi.cancelJob()}
            />

            <DisplayControlPanel
              showBlockChrome={showBlockChrome}
              showTextBlocks={showTextBlocks}
              onToggleChrome={() => setShowBlockChrome((value) => !value)}
              onToggleBlocks={() => setShowTextBlocks((value) => !value)}
            />

            {!selectedBlock ? <StatusPanel jobState={jobState} statusLines={statusLines} /> : null}

            <EditorPanel
              block={selectedBlock}
              disabled={selectedPageEditLocked || jobActive}
              areaTranslateAvailable={Boolean(selectedPage && selectedPageImageDataUrl && !jobActive)}
              areaTranslateSelecting={Boolean(regionSelection?.active)}
              onStartAreaTranslate={startRegionTranslationSelection}
              onUpdate={updateSelectedBlock}
              onDelete={deleteSelectedBlock}
              onDuplicate={duplicateSelectedBlock}
            />
          </>
        )}
      </aside>

      {translationSourceOpen ? (
        <TranslateSourceModal busy={importBusy} onCancel={() => setTranslationSourceOpen(false)} onSelect={(mode) => void selectTranslateSource(mode)} />
      ) : null}

      {importPreview ? (
        <ImportModal library={library} preview={importPreview} busy={importBusy} onCancel={() => setImportPreview(null)} onSubmit={(payload) => void submitImport(payload)} />
      ) : null}

      {shareExportOpen ? (
        <ShareExportModal
          library={library}
          currentWorkId={currentChapter?.workId ?? null}
          busy={shareExportBusy}
          onCancel={() => {
            if (!shareExportBusy) {
              setShareExportOpen(false);
            }
          }}
          onSubmit={(request) => void submitShareExport(request)}
        />
      ) : null}

      {shareImportPreview ? (
        <ShareImportModal
          library={library}
          preview={shareImportPreview}
          busy={shareImportBusy}
          onCancel={() => {
            if (!shareImportBusy) {
              setShareImportPreview(null);
            }
          }}
          onSubmit={(payload) => void submitShareImport(payload)}
        />
      ) : null}

      {renameTarget ? (
        <RenameModal
          kind={renameTarget.kind}
          initialTitle={renameTarget.title}
          busy={renameBusy}
          onCancel={() => {
            if (!renameBusy) {
              setRenameTarget(null);
            }
          }}
          onDelete={() => void deleteRenameTarget()}
          onSubmit={(title) => void submitRename(title)}
        />
      ) : null}

      {settingsOpen && settings ? (
        <SettingsModal
          initialSettings={settings}
          busy={settingsBusy}
          jobActive={jobActive}
          onCancel={() => {
            if (!settingsBusy) {
              setSettingsOpen(false);
            }
          }}
          onOpenLogFolder={() => {
            void window.mangaApi.openLogFolder();
          }}
          onReset={() => void resetSettings()}
          onSubmit={(nextSettings) => void submitSettings(nextSettings)}
        />
      ) : null}

      {confirmDialog ? (
        <ConfirmModal
          title={confirmDialog.title}
          message={confirmDialog.message}
          detail={confirmDialog.detail}
          onConfirm={() => resolveConfirmDialog(true)}
          onCancel={() => resolveConfirmDialog(false)}
        />
      ) : null}

      {inpaintingGuideOpen ? (
        <InpaintingGuideModal
          onClose={(hideNextTime) => {
            if (hideNextTime) {
              window.localStorage.setItem(INPAINTING_GUIDE_HIDDEN_KEY, "1");
              setHideInpaintingGuide(true);
            }
            setInpaintingGuideOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

function countChapterBlocks(chapter: ChapterSnapshot | null): BlockCounts {
  if (!chapter) {
    return { total: 0 };
  }
  return chapter.pages.reduce<BlockCounts>(
    (counts, page) => {
      counts.total += page.blocks.length;
      return counts;
    },
    { total: 0 }
  );
}

