import type {
  PageImageExportChapterSelection,
  PageImageExportRequest,
} from "../../shared/pageImageExportTypes";
import type { ChapterSnapshot, MangaPage } from "../../shared/libraryTypes";
import type { PageImageExportRepository } from "./pageImageExportPorts";
import { tMain } from "./localization";
import {
  createPageJobTargetSnapshot,
  createPageRevision,
} from "../../shared/pageRevision";
import type { PageImageExportPreflightResult } from "../../shared/pageImageExportTypes";
import type { PageImageExportPreflightIssue } from "../../shared/pageImageExportTypes";
import { buildPageImageExportRelativePath } from "./pageImageExportNaming";

type ResolvedExportPage = {
  page: MangaPage;
  pageIndex: number;
};

type ResolvedExportChapter = {
  chapter: ChapterSnapshot;
  chapterIndex: number;
  pages: ResolvedExportPage[];
};

export type ResolvedPageImageExport = {
  workTitle: string;
  chapters: ResolvedExportChapter[];
  pageCount: number;
};

export async function resolvePageImageExportSelection(
  request: PageImageExportRequest,
  repository: PageImageExportRepository,
): Promise<ResolvedPageImageExport> {
  const library = await repository.listLibrary();
  const work = library.works.find(
    (candidate) => candidate.id === request.workId,
  );
  if (!work) {
    throw new Error(tMain("export.errors.workNotFound"));
  }

  const selections = validateUniqueChapterSelections(request.selections);
  const chapterIds = new Set(work.chapters.map((chapter) => chapter.id));
  for (const chapterId of selections.keys()) {
    if (!chapterIds.has(chapterId)) {
      throw new Error(tMain("export.errors.chapterNotFound"));
    }
  }

  const chapters = await resolveSelectedChapters({
    chapterOrder: work.chapterOrder,
    selections,
    repository,
    workId: work.id,
  });
  const pageCount = chapters.reduce(
    (total, chapter) => total + chapter.pages.length,
    0,
  );
  if (pageCount === 0) {
    throw new Error(tMain("export.noPages"));
  }
  assertExpectedExportTargets(request, chapters);
  return { workTitle: work.title, chapters, pageCount };
}

export async function preflightPageImageExport(
  request: PageImageExportRequest,
  repository: PageImageExportRepository,
): Promise<PageImageExportPreflightResult> {
  const resolved = await resolvePageImageExportSelection(
    { ...request, expectedTargets: undefined },
    repository,
  );
  const firstChapter = resolved.chapters[0];
  const firstPage = firstChapter?.pages[0];
  if (!firstChapter || !firstPage) {
    throw new Error(tMain("export.noPages"));
  }
  const issues = resolved.chapters.flatMap((chapter) =>
    chapter.pages.flatMap(({ page }) =>
      buildPageExportIssues(chapter.chapter, page, request.omitText === true),
    ),
  );
  return {
    workTitle: resolved.workTitle,
    chapterCount: resolved.chapters.length,
    pageCount: resolved.pageCount,
    sampleRelativePath: buildPageImageExportRelativePath({
      chapterIndex: firstChapter.chapterIndex,
      chapterTitle: firstChapter.chapter.title,
      pageIndex: firstPage.pageIndex,
      pageName: firstPage.page.name,
      outputFormat: request.outputFormat ?? "png",
    }),
    outputPolicy: "new-timestamped-folder",
    issues,
    targets: resolved.chapters.flatMap(({ chapter, pages }) =>
      pages.map(({ page }) => createPageJobTargetSnapshot(chapter.id, page)),
    ),
  };
}

function assertExpectedExportTargets(
  request: PageImageExportRequest,
  chapters: ResolvedExportChapter[],
): void {
  if (!request.expectedTargets) return;
  const expected = new Map(
    request.expectedTargets.map((target) => [
      `${target.chapterId}:${target.pageId}`,
      target.revision,
    ]),
  );
  const selectedPages = chapters.flatMap(({ chapter, pages }) =>
    pages.map(({ page }) => ({ chapterId: chapter.id, page })),
  );
  if (expected.size !== selectedPages.length) {
    throw new Error(
      "출력 범위가 사전 점검 후 변경되었습니다. 다시 확인해 주세요.",
    );
  }
  for (const { chapterId, page } of selectedPages) {
    const revision = expected.get(`${chapterId}:${page.id}`);
    if (!revision || revision !== createPageRevision(page)) {
      throw new Error(
        "페이지가 사전 점검 후 변경되었습니다. 출력 전 확인을 다시 실행해 주세요.",
      );
    }
  }
}

function buildPageExportIssues(
  chapter: ChapterSnapshot,
  page: MangaPage,
  omitText: boolean,
): PageImageExportPreflightResult["issues"] {
  const base = {
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    pageId: page.id,
    pageName: page.name,
  };
  const issues: PageImageExportPreflightResult["issues"] = [];
  const pageIssues = [
    resolveTranslationIssue(page, omitText),
    resolvePostprocessIssue(page, omitText),
    resolveEmptyTranslationIssue(page, omitText),
  ];
  for (const issue of pageIssues) {
    if (issue) issues.push({ ...base, ...issue });
  }
  return issues;
}

type ExportIssueSummary = Pick<
  PageImageExportPreflightIssue,
  "code" | "severity"
>;

function resolveTranslationIssue(
  page: MangaPage,
  omitText: boolean,
): ExportIssueSummary | null {
  if (page.analysisStatus === "running") {
    return { code: "job-running", severity: "warning" };
  }
  if (omitText) return null;
  if (
    page.analysisStatus === "failed" ||
    page.translationCompletion?.status === "failed"
  ) {
    return { code: "translation-failed", severity: "warning" };
  }
  return page.analysisStatus === "completed"
    ? null
    : { code: "translation-pending", severity: "warning" };
}

function resolvePostprocessIssue(
  page: MangaPage,
  omitText: boolean,
): ExportIssueSummary | null {
  if (omitText) {
    return page.inpaintedImagePath
      ? null
      : { code: "inpainted-image-missing", severity: "warning" };
  }
  return page.translationCompletion &&
    page.translationCompletion.status !== "completed"
    ? { code: "postprocess-pending", severity: "warning" }
    : null;
}

function resolveEmptyTranslationIssue(
  page: MangaPage,
  omitText: boolean,
): ExportIssueSummary | null {
  const isEmpty =
    page.blocks.length > 0 &&
    page.blocks.every((block) => block.translatedText.trim().length === 0);
  return !omitText && isEmpty
    ? { code: "empty-translation", severity: "info" }
    : null;
}

async function resolveSelectedChapters({
  chapterOrder,
  selections,
  repository,
  workId,
}: {
  chapterOrder: string[];
  selections: Map<string, PageImageExportChapterSelection>;
  repository: PageImageExportRepository;
  workId: string;
}): Promise<ResolvedExportChapter[]> {
  const chapters: ResolvedExportChapter[] = [];
  for (const [chapterIndex, chapterId] of chapterOrder.entries()) {
    const selection = selections.get(chapterId);
    if (!selection) {
      continue;
    }
    const chapter = await repository.openChapter(chapterId);
    if (chapter.workId !== workId) {
      throw new Error(tMain("export.errors.chapterNotFound"));
    }
    const pages = resolveChapterPages(chapter, selection);
    if (pages.length > 0) {
      chapters.push({ chapter, chapterIndex, pages });
    }
  }
  return chapters;
}

function validateUniqueChapterSelections(
  selections: PageImageExportChapterSelection[],
): Map<string, PageImageExportChapterSelection> {
  const result = new Map<string, PageImageExportChapterSelection>();
  for (const selection of selections) {
    if (result.has(selection.chapterId)) {
      throw new Error(tMain("export.errors.duplicateChapter"));
    }
    result.set(selection.chapterId, selection);
  }
  return result;
}

function resolveChapterPages(
  chapter: ChapterSnapshot,
  selection: PageImageExportChapterSelection,
): ResolvedExportPage[] {
  if (selection.mode === "all") {
    return chapter.pages.map((page, pageIndex) => ({ page, pageIndex }));
  }

  const pageIds = new Set<string>();
  for (const pageId of selection.pageIds) {
    if (pageIds.has(pageId)) {
      throw new Error(tMain("export.errors.duplicatePage"));
    }
    pageIds.add(pageId);
  }
  const knownPageIds = new Set(chapter.pages.map((page) => page.id));
  for (const pageId of pageIds) {
    if (!knownPageIds.has(pageId)) {
      throw new Error(tMain("export.errors.pageNotFound"));
    }
  }
  return chapter.pages.flatMap((page, pageIndex) =>
    pageIds.has(page.id) ? [{ page, pageIndex }] : [],
  );
}
