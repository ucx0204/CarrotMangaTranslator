import { useMemo, type RefObject } from "react";
import type { InpaintingMaskStroke } from "../../../../shared/inpaintingTypes";
import type {
  ChapterSnapshot,
  MangaPage,
} from "../../../../shared/libraryTypes";
import type { JobState } from "../../../../shared/jobTypes";
import { usePageImageDataUrls } from "../../hooks/usePageImageDataUrls";
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
} from "./appSessionSelectors";

type UseAppSessionDerivedStateArgs = {
  currentChapter: ChapterSnapshot | null;
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingTool: InpaintingTool;
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
  const {
    clearPageImageCache,
    selectedPageImageDataUrl,
    selectedPageImageDataUrlPageId,
    selectedPageOriginalImageDataUrl,
    selectedPageOriginalImageDataUrlPageId,
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
    selectedPageOriginalImageDataUrl,
    selectedPageOriginalImageDataUrlPageId,
  });
  const progressState = useProgressState(jobState);

  return {
    ...pageState,
    ...progressState,
    ...workspaceState,
    clearPageImageCache,
    inpaintingToolActive: inpaintingTool !== "none",
    regionSelectionRect: resolveRegionSelectionRect(regionSelection),
    selectedPageEditLocked: resolveSelectedPageEditLocked(
      progressState.jobActive,
      pageState.selectedPage,
    ),
    selectedPageImageDataUrl,
    selectedPageOriginalImageDataUrl,
    showProgressBar:
      jobState.status !== "idle" && Boolean(progressState.progressSnapshot),
  };
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
  const neighborTargets = useMemo(
    () => resolveNeighborImageTargets(currentChapter?.pages, selectedPage),
    [currentChapter?.pages, selectedPage],
  );
  const selectedBlock =
    selectedPage?.blocks.find((block) => block.id === selectedBlockId) ?? null;
  const effectiveSelectedBlockIds = resolveEffectiveSelectedBlockIds(
    selectedPage,
    selectedBlockId,
    selectedBlockIds,
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
  selectedPageOriginalImageDataUrl,
  selectedPageOriginalImageDataUrlPageId,
}: {
  imageRef: RefObject<HTMLImageElement | null>;
  peekOriginal: boolean;
  selectedPage: MangaPage | null;
  selectedPageImageDataUrl: string;
  selectedPageImageDataUrlPageId: string | null;
  selectedPageOriginalImageDataUrl: string;
  selectedPageOriginalImageDataUrlPageId: string | null;
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

  return {
    peekAvailable: workspaceImage.peekAvailable,
    showingOriginalPeek: workspaceImage.showingOriginalPeek,
    stageSize,
    workspaceImageDataUrl: workspaceImage.imageDataUrl,
    workspaceImagePageId,
  };
}

function useProgressState(jobState: JobState) {
  const progressSnapshot = useMemo(
    () => resolveProgressSnapshot(jobState),
    [jobState],
  );

  return {
    jobActive: resolveJobActive(jobState.status),
    progressSnapshot,
  };
}

function resolveRegionSelectionRect(
  regionSelection: RegionSelectionState | null,
) {
  return regionSelection ? regionSelectionToBbox(regionSelection) : null;
}

function resolveSelectedPageEditLocked(
  jobActive: boolean,
  selectedPage: MangaPage | null,
): boolean {
  return Boolean(
    jobActive && selectedPage && selectedPage.analysisStatus !== "completed",
  );
}

function resolveSelectedPageSize(
  selectedPage: MangaPage | null,
): { width: number; height: number } | null {
  return selectedPage
    ? { width: selectedPage.width, height: selectedPage.height }
    : null;
}
