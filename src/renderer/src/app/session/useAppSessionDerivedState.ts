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
  inpaintingMode: boolean;
  inpaintingTool: InpaintingTool;
  jobState: JobState;
  patternMaskStrokesByPage: Record<string, InpaintingMaskStroke[]>;
  peekOriginal: boolean;
  regionSelection: RegionSelectionState | null;
  selectedBlockId: string | null;
  selectedPageId: string | null;
};

export function useAppSessionDerivedState({
  currentChapter,
  imageRef,
  inpaintingMode,
  inpaintingTool,
  jobState,
  patternMaskStrokesByPage,
  peekOriginal,
  regionSelection,
  selectedBlockId,
  selectedPageId,
}: UseAppSessionDerivedStateArgs) {
  const pageState = useSelectedPageState({
    currentChapter,
    patternMaskStrokesByPage,
    selectedBlockId,
    selectedPageId,
  });
  const {
    clearPageImageCache,
    selectedPageImageDataUrl,
    selectedPageOriginalImageDataUrl,
  } = usePageImageDataUrls({
    chapterId: currentChapter?.id ?? null,
    neighborTargets: pageState.neighborTargets,
    selectedPage: pageState.selectedPage,
    selectedPageImagePath: pageState.selectedPageImagePath,
  });
  const workspaceState = useWorkspaceImageState({
    imageRef,
    inpaintingMode,
    peekOriginal,
    selectedPage: pageState.selectedPage,
    selectedPageImageDataUrl,
    selectedPageOriginalImageDataUrl,
  });
  const progressState = useProgressState(jobState);

  return {
    ...pageState,
    ...progressState,
    ...workspaceState,
    clearPageImageCache,
    inpaintingToolActive: inpaintingMode && inpaintingTool !== "none",
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
  selectedPageId,
}: Pick<
  UseAppSessionDerivedStateArgs,
  | "currentChapter"
  | "patternMaskStrokesByPage"
  | "selectedBlockId"
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

  return {
    blockCounts: countChapterBlocks(currentChapter, selectedPage?.id ?? null),
    inpaintedPageCount: countInpaintedPages(currentChapter),
    neighborTargets,
    patternMaskStrokes,
    selectedBlock,
    selectedPage,
    selectedPageImagePath:
      selectedPage?.inpaintedImagePath ?? selectedPage?.imagePath ?? null,
  };
}

function useWorkspaceImageState({
  imageRef,
  inpaintingMode,
  peekOriginal,
  selectedPage,
  selectedPageImageDataUrl,
  selectedPageOriginalImageDataUrl,
}: {
  imageRef: RefObject<HTMLImageElement | null>;
  inpaintingMode: boolean;
  peekOriginal: boolean;
  selectedPage: MangaPage | null;
  selectedPageImageDataUrl: string;
  selectedPageOriginalImageDataUrl: string;
}) {
  const workspaceImage = useMemo(
    () =>
      resolveWorkspaceImageDataUrl({
        inpaintingMode,
        peekOriginal,
        selectedPage,
        selectedPageImageDataUrl,
        selectedPageOriginalImageDataUrl,
      }),
    [
      inpaintingMode,
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

  return {
    peekAvailable: workspaceImage.peekAvailable,
    showingOriginalPeek: workspaceImage.showingOriginalPeek,
    stageSize,
    workspaceImageDataUrl: workspaceImage.imageDataUrl,
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
