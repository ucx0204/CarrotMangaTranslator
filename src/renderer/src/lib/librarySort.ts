import type { LibraryIndex, LibraryWorkSummary } from "../../../shared/types";

export type LibrarySortKey = "updated" | "title" | "created" | "chapters";
export type LibrarySortDirection = "asc" | "desc";

export type LibrarySort = {
  key: LibrarySortKey;
  direction: LibrarySortDirection;
};

export const LIBRARY_SORT_OPTIONS: ReadonlyArray<{
  key: LibrarySortKey;
  label: string;
}> = [
  { key: "updated", label: "수정일" },
  { key: "title", label: "이름" },
  { key: "created", label: "추가일" },
  { key: "chapters", label: "화 개수" },
];

export const DEFAULT_LIBRARY_SORT: LibrarySort = {
  key: "updated",
  direction: "desc",
};

const STORAGE_KEY = "library-sort";

// Canonical ascending comparators; descending simply reverses the result.
const ascComparators: Record<
  LibrarySortKey,
  (a: LibraryWorkSummary, b: LibraryWorkSummary) => number
> = {
  updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  title: (a, b) => a.title.localeCompare(b.title, "ko"),
  created: (a, b) => a.createdAt.localeCompare(b.createdAt),
  chapters: (a, b) => a.chapters.length - b.chapters.length,
};

export function sortLibraryIndex(
  library: LibraryIndex,
  sort: LibrarySort,
): LibraryIndex {
  const base = ascComparators[sort.key] ?? ascComparators.updated;
  const factor = sort.direction === "desc" ? -1 : 1;
  const works = [...library.works].sort((a, b) => {
    const result = base(a, b);
    // Tie-break by title (가나다) so equal keys stay deterministic.
    return result !== 0
      ? result * factor
      : a.title.localeCompare(b.title, "ko");
  });
  return {
    workOrder: works.map((work) => work.id),
    works,
  };
}

function isLibrarySortKey(value: unknown): value is LibrarySortKey {
  return (
    value === "updated" ||
    value === "title" ||
    value === "created" ||
    value === "chapters"
  );
}

function isLibrarySortDirection(value: unknown): value is LibrarySortDirection {
  return value === "asc" || value === "desc";
}

export function readLibrarySort(): LibrarySort {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const [key, direction] = (stored ?? "").split(":");
    if (isLibrarySortKey(key) && isLibrarySortDirection(direction)) {
      return { key, direction };
    }
  } catch (error) {
    void error; // localStorage 접근 불가 시 기본값으로 폴백
  }
  return DEFAULT_LIBRARY_SORT;
}

export function writeLibrarySort(sort: LibrarySort): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, `${sort.key}:${sort.direction}`);
  } catch (error) {
    void error; // 저장 실패는 무시
  }
}
