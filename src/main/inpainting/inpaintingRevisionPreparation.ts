import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import {
  applyInpaintingLayoutStates,
  cloneInpaintingLayoutStates,
  pageMatchesInpaintingLayoutStates,
  type InpaintingBlockLayoutState,
  type InpaintingPageLayoutPatch,
} from "./inpaintingLayoutState";
import {
  sameOptionalPath,
  type InpaintingRevisionChange,
} from "./inpaintingRevisionHelpers";

export type PreparedInpaintingPageRevision = {
  nextPage: MangaPage;
  originalPage: MangaPage;
  nextLayoutPatch?: InpaintingPageLayoutPatch;
  originalLayoutPatch?: InpaintingPageLayoutPatch;
};

export function prepareInpaintingPageRevision({
  chapter,
  change,
  direction,
}: {
  chapter: ChapterSnapshot;
  change: InpaintingRevisionChange;
  direction: "undo" | "redo";
}): PreparedInpaintingPageRevision {
  const page = chapter.pages.find(
    (candidate) => candidate.id === change.pageId,
  );
  if (!page) {
    throw new Error("인페인팅 기록의 페이지를 찾지 못했습니다.");
  }
  const expectedPath =
    direction === "undo" ? change.afterPath : change.beforePath;
  if (!sameOptionalPath(page.inpaintedImagePath, expectedPath)) {
    throw new Error(
      "페이지가 다른 작업으로 변경되어 인페인팅 기록을 적용할 수 없습니다.",
    );
  }
  const expectedLayout =
    direction === "undo" ? change.afterLayout : change.beforeLayout;
  if (!pageMatchesInpaintingLayoutStates(page, expectedLayout)) {
    throw new Error(
      "페이지의 텍스트 배치가 다른 작업으로 변경되어 인페인팅 기록을 적용할 수 없습니다.",
    );
  }
  const targetPath =
    direction === "undo" ? change.beforePath : change.afterPath;
  const targetLayout =
    direction === "undo" ? change.beforeLayout : change.afterLayout;
  return {
    originalPage: page,
    nextPage: applyInpaintingLayoutStates(
      {
        ...page,
        inpaintedImagePath: targetPath,
        updatedAt: new Date().toISOString(),
      },
      targetLayout ?? [],
    ),
    nextLayoutPatch: createLayoutPatch(change.pageId, targetLayout),
    originalLayoutPatch: createLayoutPatch(change.pageId, expectedLayout),
  };
}

function createLayoutPatch(
  pageId: string,
  states: readonly InpaintingBlockLayoutState[] | undefined,
): InpaintingPageLayoutPatch | undefined {
  if (!states || states.length === 0) {
    return undefined;
  }
  return {
    pageId,
    states: cloneInpaintingLayoutStates(states) ?? [],
  };
}
