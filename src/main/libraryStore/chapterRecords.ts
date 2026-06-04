import type { LibraryChapter, LibraryChapterSummary, LibraryPageRecord } from "../../shared/types";

export function reorderIds(currentOrder: string[], nextOrder: string[]): string[] {
  const currentSet = new Set(currentOrder);
  const filtered = nextOrder.filter((id) => currentSet.has(id));
  const remainder = currentOrder.filter((id) => !filtered.includes(id));
  return [...filtered, ...remainder];
}

export function reorderRecords<T extends { id: string }>(records: T[], order: string[]): T[] {
  const recordMap = new Map(records.map((record) => [record.id, record]));
  const ordered: T[] = [];
  for (const id of order) {
    const record = recordMap.get(id);
    if (record) {
      ordered.push(record);
      recordMap.delete(id);
    }
  }
  return [...ordered, ...recordMap.values()];
}

export function resolveChapterStatus(pages: Array<Pick<LibraryPageRecord, "analysisStatus">>): LibraryChapter["status"] {
  if (pages.length === 0) {
    return "idle";
  }
  const statuses = pages.map((page) => page.analysisStatus);
  if (statuses.every((status) => status === "completed")) {
    return "completed";
  }
  if (statuses.some((status) => status === "running")) {
    return "running";
  }
  if (statuses.every((status) => status === "failed")) {
    return "failed";
  }
  return statuses.some((status) => status === "completed") ? "partial" : "idle";
}

export function toChapterSummary(chapter: LibraryChapter): LibraryChapterSummary {
  return {
    id: chapter.id,
    workId: chapter.workId,
    title: chapter.title,
    status: chapter.status,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
    pageCount: chapter.pages.length
  };
}
