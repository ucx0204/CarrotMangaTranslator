import React, { useCallback, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  BBox,
  BlockType,
  ChapterSnapshot,
  ImportPreviewResult,
  JobEvent,
  JobState,
  LibraryIndex,
  MangaPage,
  TranslationBlock,
  WorkShareExportRequest,
  WorkShareImportPreview
} from "../../shared/types";
import { resolveBlockVisualStyle } from "../../shared/blockVisuals";
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
import { EditorPanel } from "./components/EditorPanel";
import { ImageStage } from "./components/ImageStage";
import { InstallProgressOverlay } from "./components/InstallProgressOverlay";
import { ImportModal, type ImportModalSubmit } from "./components/ImportModal";
import { LibraryTree } from "./components/LibraryTree";
import { PageList } from "./components/PageList";
import { RenameModal } from "./components/RenameModal";
import { SettingsModal } from "./components/SettingsModal";
import { ShareExportModal } from "./components/ShareExportModal";
import { ShareImportModal, type ShareImportModalSubmit } from "./components/ShareImportModal";
import { TranslateSourceModal, type TranslateSourceMode } from "./components/TranslateSourceModal";
import { useStageSize } from "./hooks/useStageSize";
import { markChapterPagesRunning, mergeLiveChapterPreservingDirtyPages, resolveSelectionAfterChapterSync } from "./lib/chapterSync";
import { formatJobEventLine, formatJobLabel, resolveProgressSnapshot, summarizeWarnings } from "./lib/jobProgress";
import inpaintingGuideImage from "./assets/images/inpainting-guide.png";
import { resolveAdjacentPageId, resolveKeyboardPageNavigation, resolveWheelPageNavigation } from "./lib/pageNavigation";
import "./styles.css";

const EMPTY_JOB: JobState = {
  id: "idle",
  kind: "gemma-analysis",
  status: "idle",
  progressText: "대기 중"
};

const PAGE_IMAGE_CACHE_LIMIT = 3;

type DragMode = "move" | "resize";

type DragState = {
  mode: DragMode;
  blockId: string;
  startX: number;
  startY: number;
  startBbox: BBox;
};

type RegionSelectionState = {
  active: boolean;
  dragging: boolean;
  start: {
    x: number;
    y: number;
  };
  current: {
    x: number;
    y: number;
  };
};

type InpaintingStep = "classify" | "solid-review" | "nonsolid-review" | "ready" | "running";

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
  const [inpaintingStep, setInpaintingStep] = useState<InpaintingStep>("classify");
  const [inpaintingGuideOpen, setInpaintingGuideOpen] = useState(false);
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

  const selectedPage = useMemo(
    () => currentChapter?.pages.find((page) => page.id === selectedPageId) ?? currentChapter?.pages[0] ?? null,
    [currentChapter?.pages, selectedPageId]
  );
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
  const inpaintingHighlightType: BlockType | null =
    inpaintingMode && inpaintingStep === "solid-review"
      ? "solid"
      : inpaintingMode && inpaintingStep === "nonsolid-review"
        ? "nonsolid"
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
    setRegionSelection(null);
  }, [selectedPage?.id]);

  React.useEffect(() => {
    if (!currentChapter) {
      setInpaintingMode(false);
      setInpaintingStep("classify");
      setInpaintingGuideOpen(false);
    }
  }, [currentChapter]);

  React.useEffect(() => {
    pageImageCacheRef.current.clear();
    setSelectedPageImageDataUrl("");
  }, [currentChapter?.id]);

  React.useEffect(() => {
    if (!selectedPage) {
      setSelectedPageImageDataUrl("");
      return;
    }

    const cached = pageImageCacheRef.current.get(selectedPage.id);
    if (cached) {
      setSelectedPageImageDataUrl(cached);
      return;
    }

    let cancelled = false;
    setSelectedPageImageDataUrl("");
    void window.mangaApi
      .getPageImageDataUrl(selectedPage.imagePath)
      .then((dataUrl) => {
        if (cancelled) {
          return;
        }
        const cache = pageImageCacheRef.current;
        cache.delete(selectedPage.id);
        cache.set(selectedPage.id, dataUrl);
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
  }, [selectedPage?.id, selectedPage?.imagePath]);

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
    setInpaintingStep("classify");
    setSelectedBlockId(null);
    setRegionSelection(null);
    setShowBlockChrome(true);
    setShowTextBlocks(true);
    setInpaintingGuideOpen(true);
    pushStatus("인페인팅 모드로 전환했습니다. 먼저 배경 종류와 영역을 확인하세요.");
  }, [currentChapter, dirty, jobActive, pushStatus, saveNow]);

  const exitInpaintingMode = useCallback(() => {
    if (jobActive) {
      return;
    }
    setInpaintingMode(false);
    setInpaintingStep("classify");
    setInpaintingGuideOpen(false);
    setSelectedBlockId(null);
    setRegionSelection(null);
    pushStatus("인페인팅 모드를 종료했습니다.");
  }, [jobActive, pushStatus]);

  const advanceInpaintingStep = useCallback(
    async (step: InpaintingStep) => {
      if (step === "running") {
        const confirmed = await askConfirm(
          "인페인팅 작업 시작",
          "현재 화의 선택된 대상에 긴 작업을 실행합니다.",
          "실행 전 단색/무늬 배경 분류와 영역을 확인하세요."
        );
        if (!confirmed) {
          return;
        }
      }
      setInpaintingStep(step);
      if (step === "solid-review") {
        setShowTextBlocks(true);
        setShowBlockChrome(true);
        pushStatus("단색 배경 블록 확인 단계입니다.");
      } else if (step === "nonsolid-review") {
        setShowTextBlocks(true);
        setShowBlockChrome(true);
        pushStatus("무늬 배경 블록 편집 단계입니다.");
      } else if (step === "ready") {
        pushStatus("인페인팅 실행 전 확인 단계입니다.");
      } else if (step === "running") {
        pushStatus("인페인팅 엔진 연결 전입니다. UI 단계만 준비되었습니다.");
      }
    },
    [askConfirm, pushStatus]
  );

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
                const nextVisualStyle = resolveBlockVisualStyle(nextType);
                return {
                  ...block,
                  ...patch,
                  type: nextType,
                  renderDirection: nextRenderDirection,
                  rotationDeg: normalizeRotationDeg(patch.rotationDeg ?? block.rotationDeg ?? 0),
                  backgroundColor: patch.type ? nextVisualStyle.backgroundColor : patch.backgroundColor ?? block.backgroundColor,
                  opacity: patch.type ? nextVisualStyle.defaultOpacity : patch.opacity ?? block.opacity,
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

  const onBlockPointerDown = (event: React.PointerEvent, block: TranslationBlock, mode: DragMode) => {
    if (!stageRef.current || selectedPageEditLocked || regionSelection?.active) {
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

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const pageIds = currentChapterRef.current?.pages.map((page) => page.id) ?? [];
      const activeElement = typeof document !== "undefined" ? document.activeElement : null;
      const navigation = resolveKeyboardPageNavigation({
        key: event.key,
        hasPages: pageIds.length > 0,
        modalOpen,
        editableTarget: isEditableTarget(event.target),
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
  }, [modalOpen, selectAdjacentPageForReading]);

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

  return (
    <main className={`app-shell ${inpaintingMode ? "inpainting-mode" : ""}`}>
      <aside className={`sidebar ${inpaintingMode ? "inpainting-sidebar" : ""}`}>
        {inpaintingMode ? (
          <>
            <section className="inpainting-exit-panel">
              <button className="danger" onClick={exitInpaintingMode} disabled={jobActive}>
                인페인팅 나가기
              </button>
              <small>{currentChapter ? currentChapter.title : "현재 화 없음"}</small>
            </section>

            <PageList
              pages={currentChapter?.pages ?? []}
              selectedPageId={selectedPage?.id ?? null}
              jobActive={true}
              onSelect={selectPageForReading}
              onRetranslate={(pageId) => void retranslatePage(pageId)}
              onRemove={(pageId) => void removePage(pageId)}
              onReorder={() => undefined}
            />
          </>
        ) : (
          <>
            <section className="toolbar">
              <button className="primary" onClick={() => setTranslationSourceOpen(true)} disabled={jobActive}>
                번역
              </button>
              <button onClick={() => void openImportPreview("zip-folder")} disabled={jobActive}>
                작품 일괄 번역
              </button>
              <button onClick={() => void openSettings()} disabled={settingsBusy && !settingsOpen}>
                설정
              </button>
              <button onClick={() => void window.mangaApi.openLibraryFolder()}>보관함 폴더</button>
              <button className="share-button" onClick={() => setShareExportOpen(true)} disabled={jobActive || library.works.length === 0}>
                공유하기
              </button>
              <button className="import-button" onClick={() => void openShareImportPreview()} disabled={jobActive}>
                가져오기
              </button>
            </section>

            <LibraryTree
              library={library}
              currentChapterId={currentChapter?.id ?? null}
              jobActive={jobActive}
              onOpenChapter={(chapterId) => void openChapter(chapterId)}
              onRenameWork={(workId) => void renameWork(workId)}
              onRenameChapter={(chapterId) => void renameChapter(chapterId)}
              onReorderChapter={(workId, sourceChapterId, targetChapterId) => {
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
              }}
            />

            <PageList
              pages={currentChapter?.pages ?? []}
              selectedPageId={selectedPage?.id ?? null}
              jobActive={jobActive}
              onSelect={selectPageForReading}
              onRetranslate={(pageId) => void retranslatePage(pageId)}
              onRemove={(pageId) => void removePage(pageId)}
              onReorder={(sourcePageId, targetPageId) => {
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
              }}
            />
          </>
        )}
      </aside>

      <section
        ref={workspacePanelRef}
        className="workspace"
        tabIndex={0}
        aria-label="읽기 영역"
        onMouseDown={() => workspacePanelRef.current?.focus()}
        onWheel={onWorkspaceWheel}
      >
        {selectedPage ? (
          <div className="workspace-pane">
            <ImageStage
              page={selectedPage}
              imageDataUrl={selectedPageImageDataUrl}
              imageRef={imageRef}
              stageRef={stageRef}
              stageSize={stageSize}
              selectedBlockId={selectedBlockId}
              showTextBlocks={showTextBlocks}
              showBlockChrome={showBlockChrome}
              highlightBlockType={inpaintingHighlightType}
              regionSelectionActive={Boolean(regionSelection?.active)}
              regionSelectionRect={regionSelectionRect}
              onStagePointerMove={onStagePointerMove}
              onStagePointerUp={onStagePointerUp}
              onStagePointerDown={onStagePointerDown}
              onBlockPointerDown={onBlockPointerDown}
            />
          </div>
        ) : (
          <div className="empty-state">
            <h2>보관함에서 화를 열거나 새로 가져오세요.</h2>
            <p>작품과 화 단위로 저장해두고, 이어서 번역하거나 페이지별로 다시 번역할 수 있습니다.</p>
            <div className="empty-actions">
              <button className="primary" onClick={() => setTranslationSourceOpen(true)}>번역</button>
              <button onClick={() => void openImportPreview("zip-folder")}>작품 일괄 번역</button>
              <button className="import-button" onClick={() => void openShareImportPreview()}>가져오기</button>
            </div>
          </div>
        )}
        <InstallProgressOverlay job={jobState} snapshot={progressSnapshot} />
      </section>

      <aside className={`right-rail ${inpaintingMode ? "inpainting-rail" : ""}`}>
        {inpaintingMode ? (
          <>
            <InpaintingControlPanel
              step={inpaintingStep}
              currentChapter={currentChapter}
              selectedPage={selectedPage}
              blockCounts={blockCounts}
              showBlockChrome={showBlockChrome}
              showTextBlocks={showTextBlocks}
              jobActive={jobActive}
              onStepChange={(step) => void advanceInpaintingStep(step)}
              onShowGuide={() => setInpaintingGuideOpen(true)}
              onToggleChrome={() => setShowBlockChrome((value) => !value)}
              onToggleBlocks={() => setShowTextBlocks((value) => !value)}
            />
            <EditorPanel
              block={selectedBlock}
              disabled={selectedPageEditLocked || jobActive}
              areaTranslateAvailable={false}
              onUpdate={updateSelectedBlock}
              onDelete={deleteSelectedBlock}
              onDuplicate={duplicateSelectedBlock}
            />
          </>
        ) : (
          <>
            <section className="run-panel">
              <div className="run-title">
                <h2>{currentChapter?.title ?? "현재 화 없음"}</h2>
                <small>{currentChapter ? `${currentChapter.pages.length}페이지` : "보관함에서 화를 열어 주세요."}</small>
              </div>
              <button className="primary" onClick={() => void runAnalysis("pending")} disabled={!currentChapter || jobActive}>
                이어서 번역
              </button>
              <button onClick={() => void runAnalysis("all")} disabled={!currentChapter || jobActive}>
                전체 다시 번역
              </button>
              <button onClick={() => void enterInpaintingMode()} disabled={!currentChapter || jobActive}>
                인페인팅
              </button>
              {jobActive ? (
                <button className="danger" onClick={() => void window.mangaApi.cancelJob()}>
                  취소
                </button>
              ) : null}
              {showProgressBar && progressSnapshot ? (
                <div className="progress-card">
                  <div className="progress-meta">
                    <span>{jobState.progressText}</span>
                    {progressSnapshot.mode === "determinate" ? (
                      <strong>
                        {progressSnapshot.current} / {progressSnapshot.total}
                      </strong>
                    ) : (
                      <strong>준비 중</strong>
                    )}
                  </div>
                  {jobState.detail ? <small className="progress-detail">{jobState.detail}</small> : null}
                  <div
                    className={`progress-track ${progressSnapshot.mode === "indeterminate" ? "indeterminate" : ""}`}
                    aria-hidden="true"
                  >
                    <div
                      className={`progress-fill ${progressSnapshot.mode === "indeterminate" ? "indeterminate" : ""}`}
                      style={
                        progressSnapshot.mode === "determinate"
                          ? { width: `${Math.round(progressSnapshot.ratio * 100)}%` }
                          : undefined
                      }
                    />
                  </div>
                </div>
              ) : null}
            </section>

            <DisplayControlPanel
              showBlockChrome={showBlockChrome}
              showTextBlocks={showTextBlocks}
              onToggleChrome={() => setShowBlockChrome((value) => !value)}
              onToggleBlocks={() => setShowTextBlocks((value) => !value)}
            />

            {!selectedBlock ? (
              <section className="status-panel">
                <h2>상태</h2>
                <div className={`job-pill ${jobState.status}`}>{jobState.progressText}</div>
                <div className="status-log-scroll">
                  {statusLines.length ? (
                    statusLines.map((line, index) => <p key={`${line}-${index}`}>{line}</p>)
                  ) : (
                    <p className="muted-line">아직 표시할 상태가 없습니다.</p>
                  )}
                </div>
              </section>
            ) : null}

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

      {inpaintingGuideOpen ? <InpaintingGuideModal onClose={() => setInpaintingGuideOpen(false)} /> : null}
    </main>
  );
}

function InpaintingGuideModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <div className="modal-backdrop guide-backdrop" role="presentation">
      <div className="modal-card inpainting-guide-modal" role="dialog" aria-modal="true" aria-label="인페인팅 안내" onMouseDown={(event) => event.stopPropagation()}>
        <img src={inpaintingGuideImage} alt="인페인팅 전 단색 배경과 무늬 배경을 확인하는 방법 안내" />
        <div className="modal-actions guide-actions">
          <button className="primary" onClick={onClose}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  title,
  message,
  detail,
  onConfirm,
  onCancel
}: {
  title: string;
  message: string;
  detail?: string;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop confirm-backdrop" role="presentation">
      <div className="modal-card confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div className="confirm-title-row">
            <span className="confirm-warning-icon" aria-hidden="true">!</span>
            <h2 id="confirm-title">{title}</h2>
          </div>
        </div>
        <section className="modal-section confirm-body">
          <strong>{message}</strong>
          {detail ? <p>{detail}</p> : null}
        </section>
        <div className="modal-actions">
          <button onClick={onCancel}>취소</button>
          <button className="primary" onClick={onConfirm}>
            확인
          </button>
        </div>
      </div>
    </div>
  );
}

type BlockCounts = {
  total: number;
  solid: number;
  nonsolid: number;
};

function InpaintingControlPanel({
  step,
  currentChapter,
  selectedPage,
  blockCounts,
  showBlockChrome,
  showTextBlocks,
  jobActive,
  onStepChange,
  onShowGuide,
  onToggleChrome,
  onToggleBlocks
}: {
  step: InpaintingStep;
  currentChapter: ChapterSnapshot | null;
  selectedPage: MangaPage | null;
  blockCounts: BlockCounts;
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  jobActive: boolean;
  onStepChange: (step: InpaintingStep) => void;
  onShowGuide: () => void;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
}): React.JSX.Element {
  return (
    <section className="inpainting-panel">
      <div className="panel-header">
        <h2>인페인팅</h2>
        <div className="inpainting-header-actions">
          <button className="inpainting-guide-button" onClick={onShowGuide}>
            안내
          </button>
          <span className="inpainting-step-badge">{resolveInpaintingStepLabel(step)}</span>
        </div>
      </div>

      <div className="inpainting-summary">
        <strong>{currentChapter?.title ?? "현재 화 없음"}</strong>
        <span>{currentChapter ? `${currentChapter.pages.length}페이지 · ${blockCounts.total}블록` : "화가 열려 있지 않습니다."}</span>
        {selectedPage ? <small>현재 페이지: {selectedPage.name}</small> : null}
      </div>

      <div className="inpainting-counts">
        <span className="type-stat solid">단색 배경 {blockCounts.solid}</span>
        <span className="type-stat nonsolid">무늬 배경 {blockCounts.nonsolid}</span>
      </div>

      <ol className="inpainting-steps">
        <InpaintingStepButton active={step === "classify"} disabled={jobActive} onClick={() => onStepChange("classify")}>
          1. 영역 재설정
        </InpaintingStepButton>
        <InpaintingStepButton active={step === "solid-review"} disabled={jobActive} onClick={() => onStepChange("solid-review")}>
          2. 단색 배경 확인
        </InpaintingStepButton>
        <InpaintingStepButton active={step === "nonsolid-review"} disabled={jobActive} onClick={() => onStepChange("nonsolid-review")}>
          3. 무늬 배경 편집
        </InpaintingStepButton>
        <InpaintingStepButton active={step === "ready"} disabled={jobActive} onClick={() => onStepChange("ready")}>
          4. 실행 준비
        </InpaintingStepButton>
      </ol>

      <DisplayControlPanel
        showBlockChrome={showBlockChrome}
        showTextBlocks={showTextBlocks}
        onToggleChrome={onToggleChrome}
        onToggleBlocks={onToggleBlocks}
      />

      <button className="primary" disabled={!currentChapter || jobActive} onClick={() => onStepChange("running")}>
        현재 단계 적용
      </button>
    </section>
  );
}

function InpaintingStepButton({
  active,
  disabled,
  children,
  onClick
}: {
  active: boolean;
  disabled: boolean;
  children: React.ReactNode;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <li>
      <button className={active ? "active" : ""} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </li>
  );
}

function DisplayControlPanel({
  showBlockChrome,
  showTextBlocks,
  onToggleChrome,
  onToggleBlocks
}: {
  showBlockChrome: boolean;
  showTextBlocks: boolean;
  onToggleChrome: () => void;
  onToggleBlocks: () => void;
}): React.JSX.Element {
  return (
    <section className="display-panel">
      <h2>표시</h2>
      <div className="display-toggle-row">
        <button className={showBlockChrome ? "active" : ""} onClick={onToggleChrome}>
          배경/테두리
        </button>
        <button className={showTextBlocks ? "active" : ""} onClick={onToggleBlocks}>
          블록 표시
        </button>
      </div>
    </section>
  );
}

function resolveInpaintingStepLabel(step: InpaintingStep): string {
  switch (step) {
    case "solid-review":
      return "단색 확인";
    case "nonsolid-review":
      return "무늬 편집";
    case "ready":
      return "실행 준비";
    case "running":
      return "작업 중";
    default:
      return "영역 재설정";
  }
}

function countChapterBlocks(chapter: ChapterSnapshot | null): BlockCounts {
  if (!chapter) {
    return { total: 0, solid: 0, nonsolid: 0 };
  }
  return chapter.pages.reduce<BlockCounts>(
    (counts, page) => {
      for (const block of page.blocks) {
        counts.total += 1;
        if (block.type === "solid") {
          counts.solid += 1;
        } else {
          counts.nonsolid += 1;
        }
      }
      return counts;
    },
    { total: 0, solid: 0, nonsolid: 0 }
  );
}

function regionSelectionToBbox(selection: RegionSelectionState): BBox {
  const x1 = Math.min(selection.start.x, selection.current.x);
  const y1 = Math.min(selection.start.y, selection.current.y);
  const x2 = Math.max(selection.start.x, selection.current.x);
  const y2 = Math.max(selection.start.y, selection.current.y);
  return clampBbox({
    x: Math.round(x1),
    y: Math.round(y1),
    w: Math.round(x2 - x1),
    h: Math.round(y2 - y1)
  });
}

function reorderByTarget(currentOrder: string[], sourceId: string, targetId: string): string[] {
  const next = [...currentOrder];
  const sourceIndex = next.indexOf(sourceId);
  const targetIndex = next.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) {
    return currentOrder;
  }
  const [item] = next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, item);
  return next;
}

function reorderRecordsByIdOrder<T extends { id: string }>(records: T[], order: string[]): T[] {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const ordered = order.flatMap((id) => {
    const record = recordMap.get(id);
    return record ? [record] : [];
  });
  const orderedIds = new Set(ordered.map((record) => record.id));
  return [...ordered, ...records.filter((record) => !orderedIds.has(record.id))];
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']"));
}

function formatErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function resolveStatusLineReplacement(event: JobEvent): ((line: string) => boolean) | undefined {
  if (
    event.phase === "ocr_running" &&
    Number.isFinite(event.pageIndex) &&
    Number.isFinite(event.pageTotal) &&
    (event.pageTotal ?? 0) > 0
  ) {
    return (line) => /^\d+ \/ \d+ 페이지 Paddle OCR 분석 중$/.test(line) || line === "페이지 Paddle OCR 분석 중";
  }
  if (event.phase === "model_requesting" || event.phase === "page_running" || event.phase === "page_retry") {
    return (line) =>
      /^\d+ \/ \d+ 페이지 (AI 번역 요청 중|번역 중|재시도 \d+ \/ \d+)$/.test(line) ||
      /^페이지 (AI 번역 요청 중|번역 중|재시도 중)$/.test(line);
  }
  if (event.phase === "booting" || event.phase === "model_downloading" || event.phase === "ready") {
    return (line) =>
      line === "모델 준비 중" ||
      line === "모델 준비 완료" ||
      line === "모델 다운로드/서버 준비 중" ||
      line === "Gemma 4 서버 시작 중" ||
      line === "Gemma 서버 시작 중" ||
      line === "Gemma 서버 준비 완료" ||
      line === "OpenAI Codex 엔드포인트 준비 중" ||
      line === "로컬 모델/서버 준비 중";
  }
  return undefined;
}
