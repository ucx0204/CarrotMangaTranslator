import { saveDirtyChanges } from "./inpaintingActionTypes";
import type { ChapterSnapshot } from "../../../shared/libraryTypes";
import { createPageRevision } from "../../../shared/pageRevision";
import { inpaintingGateway as mangaGateway } from "../api/inpaintingGateway";
import type {
  RetouchApplyOperation,
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

export async function applyRetouchRequest(
  {
    currentChapter,
    currentChapterRef,
    inpaintingPaintColor,
    selectedPage,
  }: UseInpaintingRetouchOptions,
  operation: RetouchApplyOperation,
  retainedInpaintedArtifactPaths: string[],
): ReturnType<typeof mangaGateway.applyInpaintingRetouch> {
  if (!currentChapter || !selectedPage) {
    throw new Error("리터치를 적용할 페이지를 찾지 못했습니다.");
  }
  const latest = currentChapterRef.current;
  const page =
    latest?.id === currentChapter.id
      ? latest.pages.find((candidate) => candidate.id === selectedPage.id)
      : undefined;
  if (!page) throw new Error("페이지가 변경되었습니다. 다시 선택해 주세요.");
  return mangaGateway.applyInpaintingRetouch({
    chapterId: currentChapter.id,
    pageId: selectedPage.id,
    expectedRevision: createPageRevision(page),
    mode: operation.mode,
    geometry: operation.geometry,
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

export async function saveRetouchPage(
  options: UseInpaintingRetouchOptions,
  chapterId: string,
  pageId: string,
): Promise<void> {
  if (options.savePageNow) await options.savePageNow(chapterId, pageId);
  else await saveDirtyChanges(options.dirty, options.saveNow);
}
