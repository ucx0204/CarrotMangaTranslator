import type { LibraryWorkSummary } from "../../../../shared/libraryTypes";
import type {
  WorkShareImportEntry,
  WorkSharePreviewChapter,
} from "../../../../shared/shareTypes";
import type { LeftItem } from "./shareImportTypes";

export function buildExistingItems(
  work: LibraryWorkSummary | null,
): LeftItem[] {
  return work?.chapters.map(toExistingItem) ?? [];
}

export function toExistingItem(chapter: {
  id: string;
  title: string;
  pageCount: number;
}): LeftItem {
  return {
    key: `existing:${chapter.id}`,
    source: "existing",
    chapterId: chapter.id,
    title: chapter.title,
    pageCount: chapter.pageCount,
  };
}

export function toLeftPackageItem(chapter: WorkSharePreviewChapter): LeftItem {
  return {
    key: `package:${chapter.packageChapterId}`,
    source: "package",
    packageChapterId: chapter.packageChapterId,
    title: chapter.title,
    pageCount: chapter.pageCount,
  };
}

export function toImportEntry(item: LeftItem): WorkShareImportEntry {
  if (item.source === "existing") {
    return {
      source: "existing",
      chapterId: item.chapterId,
      title: item.title,
    };
  }
  return {
    source: "package",
    packageChapterId: item.packageChapterId,
    title: item.title,
  };
}
