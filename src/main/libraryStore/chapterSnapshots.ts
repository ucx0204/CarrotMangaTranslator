import type { ChapterSnapshot, LibraryChapter } from "../../shared/types";
import { normalizeBlockType } from "../../shared/geometry";
import { reorderRecords } from "./chapterRecords";

type ChapterFile = LibraryChapter;

export function hydrateChapter(chapter: ChapterFile): ChapterSnapshot {
  const pages = reorderRecords(chapter.pages, chapter.pageOrder).map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => ({
      ...block,
      type: normalizeBlockType(block.type)
    })),
    dataUrl: ""
  }));

  return {
    ...chapter,
    pageOrder: pages.map((page) => page.id),
    pages
  };
}

export function toStoredChapter(snapshot: ChapterSnapshot, current?: ChapterFile): ChapterFile {
  const currentPages = new Map(current?.pages.map((page) => [page.id, page]) ?? []);
  return {
    ...snapshot,
    workId: current?.workId ?? snapshot.workId,
    sourceKind: current?.sourceKind ?? snapshot.sourceKind,
    createdAt: current?.createdAt ?? snapshot.createdAt,
    pages: snapshot.pages.map(({ dataUrl: _dataUrl, ...page }) => {
      const currentPage = currentPages.get(page.id);
      return {
        ...page,
        imagePath: currentPage?.imagePath ?? page.imagePath,
        inpaintedImagePath: currentPage?.inpaintedImagePath ?? page.inpaintedImagePath,
        createdAt: currentPage?.createdAt ?? page.createdAt
      };
    })
  };
}

export function validateChapterSnapshotForStorage(
  snapshot: ChapterSnapshot,
  current: ChapterFile,
  assertImagePath: (workId: string, chapterId: string, imagePath: string, message: string) => string
): void {
  const currentPageIds = new Set(current.pages.map((page) => page.id));
  const pageIds = new Set<string>();
  for (const page of snapshot.pages) {
    if (!currentPageIds.has(page.id)) {
      throw new Error("저장할 수 없는 페이지가 포함되어 있습니다.");
    }
    if (pageIds.has(page.id)) {
      throw new Error("중복된 페이지 ID가 있습니다.");
    }
    pageIds.add(page.id);
    assertImagePath(current.workId, current.id, page.imagePath, "페이지 이미지 경로가 올바르지 않습니다.");
    if (page.inpaintedImagePath) {
      assertImagePath(current.workId, current.id, page.inpaintedImagePath, "인페인팅 결과 이미지 경로가 올바르지 않습니다.");
    }
  }

  if (pageIds.size !== snapshot.pageOrder.length) {
    throw new Error("페이지 순서 정보가 페이지 목록과 맞지 않습니다.");
  }
  for (const pageId of snapshot.pageOrder) {
    if (!pageIds.has(pageId)) {
      throw new Error("페이지 순서 정보가 페이지 목록과 맞지 않습니다.");
    }
  }
}
