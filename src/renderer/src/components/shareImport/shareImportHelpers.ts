import type {
  LibraryWorkSummary,
  WorkShareImportEntry,
  WorkSharePreviewChapter,
} from "../../../../shared/types";
import type { LeftItem } from "./shareImportTypes";

export function buildExistingItems(
  work: LibraryWorkSummary | null,
): LeftItem[] {
  return (
    work?.chapters.map((chapter) => ({
      key: `existing:${chapter.id}`,
      source: "existing" as const,
      chapterId: chapter.id,
      title: chapter.title,
      pageCount: chapter.pageCount,
    })) ?? []
  );
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
