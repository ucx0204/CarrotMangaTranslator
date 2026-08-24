import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import { createPageRevision } from "../../shared/pageRevision";
import {
  applyInpaintingLayoutStates,
  cloneInpaintingLayoutStates,
  pageMatchesInpaintingLayoutStates,
  type InpaintingBlockLayoutState,
  type InpaintingPageLayoutPatch,
} from "./inpaintingLayoutState";
import {
  cloneTranslationCompletion,
  sameOptionalPath,
  translationCompletionsEqual,
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
  const page = requireRevisionPage(chapter, change.pageId);
  const { expected, target } = resolveRevisionSides(change, direction);
  assertExpectedRevision(page, expected.revision);
  assertExpectedInpaintingPath(page, expected.path);
  assertExpectedMask(page, expected.maskPath, expected.maskProvenance);
  assertExpectedLayout(page, expected.layout);
  assertExpectedCompletion(page, expected.translationCompletion);
  return {
    originalPage: {
      ...page,
      translationCompletion: cloneTranslationCompletion(
        page.translationCompletion,
      ),
    },
    nextPage: applyInpaintingLayoutStates(
      {
        ...page,
        inpaintedImagePath: target.path,
        inpaintMaskPath: target.maskPath,
        maskProvenance: target.maskProvenance,
        translationCompletion: cloneTranslationCompletion(
          target.translationCompletion,
        ),
        updatedAt: new Date().toISOString(),
      },
      target.layout ?? [],
    ),
    nextLayoutPatch: createLayoutPatch(change.pageId, target.layout),
    originalLayoutPatch: createLayoutPatch(change.pageId, expected.layout),
  };
}

function resolveRevisionSides(
  change: InpaintingRevisionChange,
  direction: "undo" | "redo",
) {
  const before = {
    revision: change.beforeRevision,
    path: change.beforePath,
    maskPath: change.beforeMaskPath,
    maskProvenance: change.beforeMaskProvenance,
    layout: change.beforeLayout,
    translationCompletion: change.beforeTranslationCompletion,
  };
  const after = {
    revision: change.afterRevision,
    path: change.afterPath,
    maskPath: change.afterMaskPath,
    maskProvenance: change.afterMaskProvenance,
    layout: change.afterLayout,
    translationCompletion: change.afterTranslationCompletion,
  };
  return direction === "undo"
    ? { expected: after, target: before }
    : { expected: before, target: after };
}

function requireRevisionPage(
  chapter: ChapterSnapshot,
  pageId: string,
): MangaPage {
  const page = chapter.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error("인페인팅 기록의 페이지를 찾지 못했습니다.");
  return page;
}

function assertExpectedRevision(
  page: MangaPage,
  expectedRevision: InpaintingRevisionChange["beforeRevision"],
): void {
  if (expectedRevision && createPageRevision(page) !== expectedRevision) {
    throw new Error(
      "페이지가 미리보기 생성 후 변경되어 인페인팅 결과를 적용할 수 없습니다.",
    );
  }
}

function assertExpectedInpaintingPath(
  page: MangaPage,
  expectedPath: string | undefined,
): void {
  if (!sameOptionalPath(page.inpaintedImagePath, expectedPath)) {
    throw new Error(
      "페이지가 다른 작업으로 변경되어 인페인팅 기록을 적용할 수 없습니다.",
    );
  }
}

function assertExpectedMask(
  page: MangaPage,
  expectedPath: string | undefined,
  expectedProvenance: MangaPage["maskProvenance"],
): void {
  if (
    !sameOptionalPath(page.inpaintMaskPath, expectedPath) ||
    page.maskProvenance !== expectedProvenance
  ) {
    throw new Error(
      "페이지의 인페인팅 마스크가 다른 작업으로 변경되어 기록을 적용할 수 없습니다.",
    );
  }
}

function assertExpectedLayout(
  page: MangaPage,
  expectedLayout: InpaintingBlockLayoutState[] | undefined,
): void {
  if (!pageMatchesInpaintingLayoutStates(page, expectedLayout)) {
    throw new Error(
      "페이지의 텍스트 배치가 다른 작업으로 변경되어 인페인팅 기록을 적용할 수 없습니다.",
    );
  }
}

function assertExpectedCompletion(
  page: MangaPage,
  expected: InpaintingRevisionChange["beforeTranslationCompletion"],
): void {
  if (!translationCompletionsEqual(page.translationCompletion, expected)) {
    throw new Error(
      "페이지의 번역 완료 상태가 다른 작업으로 변경되어 인페인팅 기록을 적용할 수 없습니다.",
    );
  }
}

export function prepareInpaintingRevertRevision({
  chapterId,
  page,
  updatedAt = new Date().toISOString(),
}: {
  chapterId: string;
  page: MangaPage;
  updatedAt?: string;
}): {
  change: InpaintingRevisionChange;
  revertedPage: MangaPage;
} {
  const pendingTranslationCompletion = page.translationCompletion
    ? {
        workflow: page.translationCompletion.workflow,
        status: "pending" as const,
      }
    : undefined;
  const revertedPage: MangaPage = {
    ...page,
    inpaintedImagePath: undefined,
    inpaintMaskPath: undefined,
    maskProvenance: undefined,
    translationCompletion: pendingTranslationCompletion,
    updatedAt,
  };
  return {
    change: {
      chapterId,
      pageId: page.id,
      beforeRevision: createPageRevision(page),
      afterRevision: createPageRevision(revertedPage),
      beforePath: page.inpaintedImagePath,
      afterPath: undefined,
      beforeMaskPath: page.inpaintMaskPath,
      afterMaskPath: undefined,
      beforeMaskProvenance: page.maskProvenance,
      afterMaskProvenance: undefined,
      beforeTranslationCompletion: cloneTranslationCompletion(
        page.translationCompletion,
      ),
      afterTranslationCompletion: cloneTranslationCompletion(
        pendingTranslationCompletion,
      ),
    },
    revertedPage,
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
