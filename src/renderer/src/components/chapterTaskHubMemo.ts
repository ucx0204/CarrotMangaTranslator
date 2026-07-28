import type { ChapterTaskHubProps } from "./chapterTaskHubTypes";

export function areChapterTaskHubPropsEqual(
  previous: ChapterTaskHubProps,
  next: ChapterTaskHubProps,
): boolean {
  return (
    isSameChapterSummary(previous, next) &&
    isSameRunState(previous, next) &&
    isSameRunActions(previous, next)
  );
}

function isSameChapterSummary(
  previous: ChapterTaskHubProps,
  next: ChapterTaskHubProps,
): boolean {
  return (
    previous.currentChapter?.id === next.currentChapter?.id &&
    previous.currentChapter?.title === next.currentChapter?.title &&
    previous.currentChapter?.pages.length === next.currentChapter?.pages.length
  );
}

function isSameRunState(
  previous: ChapterTaskHubProps,
  next: ChapterTaskHubProps,
): boolean {
  return (
    isSamePageTaskState(previous, next) && isSameProgressState(previous, next)
  );
}

function isSamePageTaskState(
  previous: ChapterTaskHubProps,
  next: ChapterTaskHubProps,
): boolean {
  return (
    previous.canRunBubbleLayout === next.canRunBubbleLayout &&
    previous.flowActive === next.flowActive &&
    previous.hasSelectedPage === next.hasSelectedPage &&
    previous.jobActive === next.jobActive
  );
}

function isSameProgressState(
  previous: ChapterTaskHubProps,
  next: ChapterTaskHubProps,
): boolean {
  return (
    previous.jobState === next.jobState &&
    previous.progressSnapshot === next.progressSnapshot &&
    previous.showProgressBar === next.showProgressBar
  );
}

function isSameRunActions(
  previous: ChapterTaskHubProps,
  next: ChapterTaskHubProps,
): boolean {
  return (
    previous.onCancelJob === next.onCancelJob &&
    previous.onOpenAutoInpaintingOptions === next.onOpenAutoInpaintingOptions &&
    previous.onOpenExport === next.onOpenExport &&
    previous.onOpenTranslateOptions === next.onOpenTranslateOptions &&
    previous.onRunBubbleLayout === next.onRunBubbleLayout &&
    previous.onRunCurrentPageInpainting === next.onRunCurrentPageInpainting
  );
}
