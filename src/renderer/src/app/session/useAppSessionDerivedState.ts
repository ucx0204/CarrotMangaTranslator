import { useMemo, type RefObject } from "react";
import type { InpaintingMaskStroke } from "../../../../shared/inpaintingTypes";
import type {
  ChapterSnapshot,
  MangaPage,
} from "../../../../shared/libraryTypes";
import type { JobState } from "../../../../shared/jobTypes";
import { isPageFullyCompleted } from "../../../../shared/pageCompletion";
import { usePageImageDataUrls } from "../../hooks/usePageImageDataUrls";
import { usePageFontPreload } from "../../hooks/usePageFontPreload";
import { useStageSize } from "../../hooks/useStageSize";
import type { InpaintingTool } from "../../inpainting/inpaintingTypes";
import {
  regionSelectionToBbox,
  type RegionSelectionState,
} from "../../lib/appHelpers";
import {
  countChapterBlocks,
  countInpaintedPages,
} from "../../lib/inpaintingStats";
import { resolveProgressSnapshot } from "../../lib/jobProgress";
import {
  resolveJobActive,
  resolveNeighborImageTargets,
  resolveSelectedPage,
  resolveWorkspaceImageDataUrl,
  type NeighborImageTarget,
} from "./appSessionSelectors";

type UseAppSessionDerivedStateArgs = {
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingTool: InpaintingTool;
  jobFlowActive: boolean;
  jobState: JobState;
  patternMaskStrokesByPage: Record<string, InpaintingMaskStroke[]>;
  peekOriginal: boolean;
  regionSelection: RegionSelectionState | null;
  selectedBlockId: string | null;
  selectedBlockIds: string[];
  selectedPageId: string | null;
};

export function useAppSessionDerivedState({
  currentChapter,
  imageRef,
  inpaintingTool,
  jobFlowActive,
  jobState,
  patternMaskStrokesByPage,
  peekOriginal,
  regionSelection,
  selectedBlockId,
  selectedBlockIds,
  selectedPageId,
}: UseAppSessionDerivedStateArgs) {
  const pageState = useSelectedPageState({
    currentChapter,
    patternMaskStrokesByPage,
    selectedBlockId,
    selectedBlockIds,
    selectedPageId,
  });
  useNeighborPageFontPreload(
    currentChapter?.pages,
    pageState.selectedPage,
    pageState.neighborTargets,
  );
  const {
    clearPageImageCache,
    selectedPageImageDataUrl,
    selectedPageImageDataUrlPageId,
    selectedPageImageLoading,
    selectedPageOriginalImageDataUrl,
    selectedPageOriginalImageDataUrlPageId,
    selectedPageOriginalImageLoading,
  } = usePageImageDataUrls({
    chapterId: currentChapter?.id ?? null,
    neighborTargets: pageState.neighborTargets,
    selectedPage: pageState.selectedPage,
    selectedPageImagePath: pageState.selectedPageImagePath,
  });
  const workspaceState = useWorkspaceImageState({
    imageRef,
    peekOriginal,
    selectedPage: pageState.selectedPage,
    selectedPageImageDataUrl,
    selectedPageImageDataUrlPageId,
    selectedPageImageLoading,
    selectedPageOriginalImageDataUrl,
    selectedPageOriginalImageDataUrlPageId,
    selectedPageOriginalImageLoading,
  });
  const progressState = useProgressState(
    jobState,
    currentChapter,
    jobFlowActive,
  );
  const regionSelectionRect = useMemo(
    () => resolveRegionSelectionRect(regionSelection),
    [regionSelection],
  );

  return {
    ...pageState,
    ...progressState,
    ...workspaceState,
    clearPageImageCache,
    inpaintingToolActive: inpaintingTool !== "none",
    regionSelectionRect,
    selectedPageEditLocked: resolveSelectedPageEditLocked(
      progressState.pageLockActive,
      progressState.jobTargetPageIds,
      pageState.selectedPage,
      jobState.kind,
    ),
    selectedPageImageDataUrl,
    selectedPageImageDataUrlPageId,
    selectedPageOriginalImageDataUrl,
    selectedPageOriginalImageDataUrlPageId,
    showProgressBar:
      jobState.status !== "idle" && Boolean(progressState.progressSnapshot),
  };
}

function resolveNeighborFontPages(
  pages: MangaPage[] | undefined,
  targets: NeighborImageTarget[],
): MangaPage[] {
  if (!pages || targets.length === 0) return [];
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  return targets.flatMap((target) => {
    const page = pagesById.get(target.pageId);
    return page ? [page] : [];
  });
}

function useNeighborPageFontPreload(
  pages: MangaPage[] | undefined,
  selectedPage: MangaPage | null,
  targets: NeighborImageTarget[],
): void {
  const neighborFontPages = useMemo(
    () => resolveNeighborFontPages(pages, targets),
    [pages, targets],
  );
  usePageFontPreload(selectedPage, neighborFontPages);
}

function useSelectedPageState({
  currentChapter,
  patternMaskStrokesByPage,
  selectedBlockId,
  selectedBlockIds,
  selectedPageId,
}: Pick<
  UseAppSessionDerivedStateArgs,
  | "currentChapter"
  | "patternMaskStrokesByPage"
  | "selectedBlockId"
  | "selectedBlockIds"
  | "selectedPageId"
>) {
  const selectedPage = useMemo(
    () => resolveSelectedPage(currentChapter, selectedPageId),
    [currentChapter, selectedPageId],
  );
  const patternMaskStrokes = useMemo(
    () =>
      selectedPage ? (patternMaskStrokesByPage[selectedPage.id] ?? []) : [],
    [patternMaskStrokesByPage, selectedPage],
  );
  const resolvedNeighborTargets = resolveNeighborImageTargets(
    currentChapter?.pages,
    selectedPage,
  );
  const neighborTargets = useStableNeighborTargets(resolvedNeighborTargets);
  const selectedBlock = useMemo(
    () =>
      selectedPage?.blocks.find((block) => block.id === selectedBlockId) ??
      null,
    [selectedBlockId, selectedPage],
  );
  const effectiveSelectedBlockIds = useMemo(
    () =>
      resolveEffectiveSelectedBlockIds(
        selectedPage,
        selectedBlockId,
        selectedBlockIds,
      ),
    [selectedBlockId, selectedBlockIds, selectedPage],
  );

  return {
    blockCounts: countChapterBlocks(currentChapter, selectedPage?.id ?? null),
    inpaintedPageCount: countInpaintedPages(currentChapter),
    neighborTargets,
    patternMaskStrokes,
    selectedBlock,
    selectedBlockIds: effectiveSelectedBlockIds,
    selectedPage,
    selectedPageImagePath:
      selectedPage?.inpaintedImagePath ?? selectedPage?.imagePath ?? null,
  };
}

function useStableNeighborTargets(
  targets: NeighborImageTarget[],
): NeighborImageTarget[] {
  const firstPageId = targets[0]?.pageId;
  const firstImagePath = targets[0]?.imagePath;
  const firstOriginalImagePath = targets[0]?.originalImagePath;
  const secondPageId = targets[1]?.pageId;
  const secondImagePath = targets[1]?.imagePath;
  const secondOriginalImagePath = targets[1]?.originalImagePath;
  return useMemo(
    () =>
      createNeighborTargets(
        firstPageId,
        firstImagePath,
        firstOriginalImagePath,
        secondPageId,
        secondImagePath,
        secondOriginalImagePath,
      ),
    [
      firstImagePath,
      firstOriginalImagePath,
      firstPageId,
      secondImagePath,
      secondOriginalImagePath,
      secondPageId,
    ],
  );
}

function createNeighborTargets(
  firstPageId: string | undefined,
  firstImagePath: string | undefined,
  firstOriginalImagePath: string | undefined,
  secondPageId: string | undefined,
  secondImagePath: string | undefined,
  secondOriginalImagePath: string | undefined,
): NeighborImageTarget[] {
  const targets: NeighborImageTarget[] = [];
  if (firstPageId && firstImagePath && firstOriginalImagePath) {
    targets.push({
      pageId: firstPageId,
      imagePath: firstImagePath,
      originalImagePath: firstOriginalImagePath,
    });
  }
  if (secondPageId && secondImagePath && secondOriginalImagePath) {
    targets.push({
      pageId: secondPageId,
      imagePath: secondImagePath,
      originalImagePath: secondOriginalImagePath,
    });
  }
  return targets;
}

/**
 * The multi-selection is honored only when the active block is part of it and
 * more than one block is selected; otherwise it collapses to the single active
 * block. Stale ids from other pages are dropped.
 */
function resolveEffectiveSelectedBlockIds(
  selectedPage: MangaPage | null,
  selectedBlockId: string | null,
  selectedBlockIds: string[],
): string[] {
  const pageBlockIds = new Set(selectedPage?.blocks.map((block) => block.id));
  const onPage = selectedBlockIds.filter((id) => pageBlockIds.has(id));
  if (
    selectedBlockId &&
    onPage.length > 1 &&
    onPage.includes(selectedBlockId)
  ) {
    return onPage;
  }
  return selectedBlockId ? [selectedBlockId] : [];
}

function useWorkspaceImageState({
  imageRef,
  peekOriginal,
  selectedPage,
  selectedPageImageDataUrl,
  selectedPageImageDataUrlPageId,
  selectedPageImageLoading,
  selectedPageOriginalImageDataUrl,
  selectedPageOriginalImageDataUrlPageId,
  selectedPageOriginalImageLoading,
}: {
  imageRef: RefObject<HTMLImageElement | null>;
  peekOriginal: boolean;
  selectedPage: MangaPage | null;
  selectedPageImageDataUrl: string;
  selectedPageImageDataUrlPageId: string | null;
  selectedPageImageLoading: boolean;
  selectedPageOriginalImageDataUrl: string;
  selectedPageOriginalImageDataUrlPageId: string | null;
  selectedPageOriginalImageLoading: boolean;
}) {
  const workspaceImage = useMemo(
    () =>
      resolveWorkspaceImageDataUrl({
        peekOriginal,
        selectedPage,
        selectedPageImageDataUrl,
        selectedPageOriginalImageDataUrl,
      }),
    [
      peekOriginal,
      selectedPage,
      selectedPageImageDataUrl,
      selectedPageOriginalImageDataUrl,
    ],
  );
  const selectedPageSize = useMemo(
    () => resolveSelectedPageSize(selectedPage),
    [selectedPage],
  );
  const stageSize = useStageSize(
    imageRef,
    selectedPageSize,
    selectedPageImageDataUrl,
  );
  const workspaceImagePageId = workspaceImage.showingOriginalPeek
    ? selectedPageOriginalImageDataUrlPageId
    : selectedPageImageDataUrlPageId;
  const workspaceImageLoading = workspaceImage.showingOriginalPeek
    ? selectedPageOriginalImageLoading
    : selectedPageImageLoading;

  return {
    peekAvailable: workspaceImage.peekAvailable,
    showingOriginalPeek: workspaceImage.showingOriginalPeek,
    stageSize,
    workspaceImageDataUrl: workspaceImage.imageDataUrl,
    workspaceImageLoading,
    workspaceImagePageId,
  };
}

function useProgressState(
  jobState: JobState,
  currentChapter: ChapterSnapshot | null,
  jobFlowActive: boolean,
) {
  const progressSnapshot = useMemo(
    () => resolveProgressSnapshot(jobState),
    [jobState],
  );
  const { kind: jobKind, status: jobStatus, targets: jobTargets } = jobState;
  const jobActive = resolveJobActive(jobStatus);
  const pageLockActive = jobActive || jobFlowActive;
  const jobTargetPageIds = useMemo(
    () =>
      resolveLockedJobTargetPageIds(
        { kind: jobKind, status: jobStatus, targets: jobTargets },
        currentChapter,
        pageLockActive,
      ),
    [currentChapter, jobKind, jobStatus, jobTargets, pageLockActive],
  );

  return {
    jobTargetPageIds,
    jobActive,
    pageLockActive,
    progressSnapshot,
  };
}

export function resolveLockedJobTargetPageIds(
  jobState: Pick<JobState, "kind" | "status" | "targets">,
  currentChapter: ChapterSnapshot | null,
  pageLockActive = resolveJobActive(jobState.status),
): ReadonlySet<string> {
  if (!pageLockActive || !currentChapter) return new Set();
  const pagesById = new Map(
    currentChapter.pages.map((page) => [page.id, page]),
  );
  return new Set(
    (jobState.targets ?? []).flatMap((target) => {
      if (target.chapterId !== currentChapter.id) return [];
      const page = pagesById.get(target.pageId);
      if (!page) return [];
      if (jobState.kind === "gemma-analysis" && isPageFullyCompleted(page)) {
        return [];
      }
      return [target.pageId];
    }),
  );
}

function resolveRegionSelectionRect(
  regionSelection: RegionSelectionState | null,
) {
  return regionSelection ? regionSelectionToBbox(regionSelection) : null;
}

function resolveSelectedPageEditLocked(
  pageLockActive: boolean,
  targetPageIds: ReadonlySet<string>,
  selectedPage: MangaPage | null,
  jobKind: JobState["kind"],
): boolean {
  if (!pageLockActive || !selectedPage) return false;
  if (targetPageIds.size > 0) return targetPageIds.has(selectedPage.id);
  if (jobKind === "inpainting") return true;
  return selectedPage.analysisStatus === "running";
}

function resolveSelectedPageSize(
  selectedPage: MangaPage | null,
): { width: number; height: number } | null {
  return selectedPage
    ? { width: selectedPage.width, height: selectedPage.height }
    : null;
}
