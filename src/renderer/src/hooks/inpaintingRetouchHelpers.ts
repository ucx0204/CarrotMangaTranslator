import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { mangaGateway } from "../api/mangaGateway";
import type {
  RetouchApplyTool,
  RetouchHistoryEntry,
  RetouchPoint,
  UseInpaintingRetouchOptions,
} from "./inpaintingRetouchTypes";
import type {
  InpaintingRetouchRefs,
  InpaintingRetouchState,
} from "./inpaintingRetouchState";

export function collectRetainedRetouchArtifactPaths(
  ...sources: Array<
    RetouchHistoryEntry[] | Array<string | undefined> | undefined
  >
): string[] {
  const retainedPaths = new Set<string>();
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const item of source) {
      if (typeof item === "string") {
        retainedPaths.add(item);
        continue;
      }
      if (!item) {
        continue;
      }
      if (item.beforePath) {
        retainedPaths.add(item.beforePath);
      }
      if (item.afterPath) {
        retainedPaths.add(item.afterPath);
      }
    }
  }
  return Array.from(retainedPaths);
}

export function distanceBetween(
  first: RetouchPoint,
  second: RetouchPoint,
): number {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function roundRetouchPoint(point: RetouchPoint): RetouchPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export function updateChapterInpaintPath(
  chapter: ChapterSnapshot,
  pageId: string,
  inpaintedImagePath?: string,
): ChapterSnapshot {
  return {
    ...chapter,
    pages: chapter.pages.map((page) =>
      page.id === pageId
        ? { ...page, inpaintedImagePath, updatedAt: new Date().toISOString() }
        : page,
    ),
  };
}

export async function applyRetouchRequest(
  {
    currentChapter,
    inpaintingBrushRadius,
    inpaintingPaintColor,
    selectedPage,
  }: UseInpaintingRetouchOptions,
  tool: RetouchApplyTool,
  points: RetouchPoint[],
  retainedInpaintedArtifactPaths: string[],
): ReturnType<typeof mangaGateway.applyInpaintingRetouch> {
  if (!currentChapter || !selectedPage) {
    throw new Error("리터치를 적용할 페이지를 찾지 못했습니다.");
  }
  return mangaGateway.applyInpaintingRetouch({
    chapterId: currentChapter.id,
    pageId: selectedPage.id,
    mode: tool === "brush" ? "paint" : "restore",
    points,
    radiusPx: inpaintingBrushRadius,
    color: inpaintingPaintColor,
    retainedInpaintedArtifactPaths,
  });
}

export function findPageInpaintPath(
  chapter: ChapterSnapshot,
  pageId: string,
): string | undefined {
  return chapter.pages.find((page) => page.id === pageId)?.inpaintedImagePath;
}

export function collectReplayRetainedPaths(
  refs: InpaintingRetouchRefs,
  entry: RetouchHistoryEntry,
): string[] {
  return collectRetainedRetouchArtifactPaths(
    refs.retouchUndoStackRef.current,
    refs.retouchRedoStackRef.current,
    [entry.beforePath, entry.afterPath],
  );
}

export function setRetouchBusyState(
  refs: InpaintingRetouchRefs,
  setRetouchBusy: InpaintingRetouchState["setRetouchBusy"],
  busy: boolean,
): void {
  refs.retouchBusyRef.current = busy;
  setRetouchBusy(busy);
}
