import type { LibraryIndex } from "../../../../shared/libraryTypes";
import type {
  WorkShareImportPreview,
  WorkSharePreviewChapter,
} from "../../../../shared/shareTypes";
import type { ShareImportModalSubmit } from "../../lib/shareImportTypes";
import {
  buildExistingItems,
  toExistingItem,
  toLeftPackageItem,
} from "./shareImportHelpers";
import type { LeftItem, NewSelection } from "./shareImportTypes";

export type ShareImportInitialState = {
  targetMode: "new" | "existing";
  newWorkTitle: string;
  existingWorkId: string;
  newSelections: NewSelection[];
  leftItems: LeftItem[];
  candidateItems: LeftItem[];
};

export function createShareImportInitialState(
  library: LibraryIndex,
  preview: WorkShareImportPreview,
  draft: ShareImportModalSubmit | null,
): ShareImportInitialState {
  const targetMode = draft?.target.mode ?? "new";
  const existingWorkId = resolveExistingWorkId(library, draft);
  const selectedWork =
    library.works.find((work) => work.id === existingWorkId) ?? null;
  const leftItems = createInitialLeftItems(preview, selectedWork, draft);
  const usedPackageIds = new Set(
    leftItems.flatMap((item) =>
      item.source === "package" ? [item.packageChapterId] : [],
    ),
  );
  return {
    targetMode,
    newWorkTitle:
      draft?.target.mode === "new" ? draft.target.title : preview.workTitle,
    existingWorkId,
    newSelections: createNewSelections(preview.chapters, draft),
    leftItems,
    candidateItems: preview.chapters
      .filter((chapter) => !usedPackageIds.has(chapter.packageChapterId))
      .map(toLeftPackageItem),
  };
}

function resolveExistingWorkId(
  library: LibraryIndex,
  draft: ShareImportModalSubmit | null,
): string {
  return draft?.target.mode === "existing"
    ? draft.target.workId
    : (library.works[0]?.id ?? "");
}

function createNewSelections(
  chapters: WorkSharePreviewChapter[],
  draft: ShareImportModalSubmit | null,
): NewSelection[] {
  const draftEntries = draft?.target.mode === "new" ? draft.entries : [];
  const entriesById = new Map(
    draftEntries.flatMap((entry) =>
      entry.source === "package"
        ? [[entry.packageChapterId, entry] as const]
        : [],
    ),
  );
  return chapters.map((chapter) => ({
    packageChapterId: chapter.packageChapterId,
    title: entriesById.get(chapter.packageChapterId)?.title ?? chapter.title,
    enabled:
      draft?.target.mode === "new"
        ? entriesById.has(chapter.packageChapterId)
        : true,
  }));
}

function createInitialLeftItems(
  preview: WorkShareImportPreview,
  selectedWork: LibraryIndex["works"][number] | null,
  draft: ShareImportModalSubmit | null,
): LeftItem[] {
  if (draft?.target.mode !== "existing") {
    return buildExistingItems(selectedWork);
  }
  const packageById = new Map(
    preview.chapters.map((chapter) => [chapter.packageChapterId, chapter]),
  );
  return draft.entries.flatMap((entry): LeftItem[] => {
    if (entry.source === "package") {
      const chapter = packageById.get(entry.packageChapterId);
      return chapter
        ? [{ ...toLeftPackageItem(chapter), title: entry.title }]
        : [];
    }
    const chapter = selectedWork?.chapters.find(
      (candidate) => candidate.id === entry.chapterId,
    );
    return chapter ? [{ ...toExistingItem(chapter), title: entry.title }] : [];
  });
}
