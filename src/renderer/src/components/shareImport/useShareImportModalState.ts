import React from "react";
import type { LibraryIndex } from "../../../../shared/libraryTypes";
import type {
  WorkShareImportEntry,
  WorkShareImportPreview,
  WorkSharePreviewChapter,
} from "../../../../shared/shareTypes";
import {
  buildExistingItems,
  toImportEntry,
  toLeftPackageItem,
} from "./shareImportHelpers";
import type {
  ActiveDrag,
  LeftItem,
  NewSelection,
  ShareImportModalSubmit,
} from "./shareImportTypes";

type ShareImportModalStateInput = {
  library: LibraryIndex;
  preview: WorkShareImportPreview;
};

type SelectedWork = LibraryIndex["works"][number] | null;

type ShareImportSubmitInput = {
  availablePackageChapters: WorkSharePreviewChapter[];
  deletedExistingChapters: Array<{ id: string; title: string }>;
  existingWorkId: string;
  leftItems: LeftItem[];
  newSelections: NewSelection[];
  newWorkTitle: string;
  targetMode: "new" | "existing";
};

export function useShareImportModalState({
  library,
  preview,
}: ShareImportModalStateInput) {
  const [targetMode, setTargetMode] = React.useState<"new" | "existing">("new");
  const [newWorkTitle, setNewWorkTitle] = React.useState(preview.workTitle);
  const [existingWorkId, setExistingWorkId] = React.useState(
    library.works[0]?.id ?? "",
  );
  const selectedWork = React.useMemo(
    () => library.works.find((work) => work.id === existingWorkId) ?? null,
    [existingWorkId, library.works],
  );
  const [newSelections, setNewSelections] = React.useState<NewSelection[]>(() =>
    createNewSelections(preview.chapters),
  );
  const [leftItems, setLeftItems] = React.useState<LeftItem[]>(() =>
    buildExistingItems(selectedWork),
  );
  const [activeDrag, setActiveDrag] = React.useState<ActiveDrag | null>(null);

  React.useEffect(() => {
    if (targetMode === "existing") {
      setLeftItems(buildExistingItems(selectedWork));
    }
  }, [selectedWork, targetMode]);

  const availablePackageChapters = useAvailablePackageChapters(
    leftItems,
    preview.chapters,
  );
  const deletedExistingChapters = useDeletedExistingChapters(
    leftItems,
    selectedWork,
  );
  const { appendAllPackageChapters, appendPackageChapter } =
    usePackageChapterAppenders(preview.chapters, setLeftItems);
  const { buildSubmitPayload, canSubmit } = useShareImportSubmitState({
    availablePackageChapters,
    deletedExistingChapters,
    existingWorkId,
    leftItems,
    newSelections,
    newWorkTitle,
    targetMode,
  });

  return {
    activeDrag,
    appendAllPackageChapters,
    appendPackageChapter,
    availablePackageChapters,
    buildSubmitPayload,
    canSubmit,
    deletedExistingChapters,
    existingWorkId,
    leftItems,
    newSelections,
    newWorkTitle,
    setActiveDrag,
    setExistingWorkId,
    setLeftItems,
    setNewSelections,
    setNewWorkTitle,
    setTargetMode,
    targetMode,
  };
}

function createNewSelections(
  chapters: WorkSharePreviewChapter[],
): NewSelection[] {
  return chapters.map((chapter) => ({
    packageChapterId: chapter.packageChapterId,
    title: chapter.title,
    enabled: true,
  }));
}

function useAvailablePackageChapters(
  leftItems: LeftItem[],
  chapters: WorkSharePreviewChapter[],
): WorkSharePreviewChapter[] {
  return React.useMemo(
    () =>
      chapters.filter(
        (chapter) =>
          !leftItems.some(
            (item) =>
              item.source === "package" &&
              item.packageChapterId === chapter.packageChapterId,
          ),
      ),
    [chapters, leftItems],
  );
}

function useDeletedExistingChapters(
  leftItems: LeftItem[],
  selectedWork: SelectedWork,
): Array<{ id: string; title: string }> {
  return React.useMemo(
    () =>
      selectedWork?.chapters
        .filter(
          (chapter) =>
            !leftItems.some(
              (item) =>
                item.source === "existing" && item.chapterId === chapter.id,
            ),
        )
        .map((chapter) => ({ id: chapter.id, title: chapter.title })) ?? [],
    [leftItems, selectedWork],
  );
}

function usePackageChapterAppenders(
  chapters: WorkSharePreviewChapter[],
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>,
): {
  appendAllPackageChapters: () => void;
  appendPackageChapter: (packageChapterId: string) => void;
} {
  const appendPackageChapter = React.useCallback(
    (packageChapterId: string) => {
      setLeftItems((current) =>
        appendPackageChapterItem(current, chapters, packageChapterId),
      );
    },
    [chapters, setLeftItems],
  );
  const appendAllPackageChapters = React.useCallback(() => {
    setLeftItems((current) => appendMissingPackageChapters(current, chapters));
  }, [chapters, setLeftItems]);
  return { appendAllPackageChapters, appendPackageChapter };
}

function appendPackageChapterItem(
  current: LeftItem[],
  chapters: WorkSharePreviewChapter[],
  packageChapterId: string,
): LeftItem[] {
  const chapter = chapters.find(
    (candidate) => candidate.packageChapterId === packageChapterId,
  );
  if (!chapter || hasPackageChapter(current, packageChapterId)) {
    return current;
  }
  return [...current, toLeftPackageItem(chapter)];
}

function appendMissingPackageChapters(
  current: LeftItem[],
  chapters: WorkSharePreviewChapter[],
): LeftItem[] {
  return [
    ...current,
    ...chapters
      .filter(
        (chapter) => !hasPackageChapter(current, chapter.packageChapterId),
      )
      .map(toLeftPackageItem),
  ];
}

function hasPackageChapter(
  items: LeftItem[],
  packageChapterId: string,
): boolean {
  return items.some(
    (item) =>
      item.source === "package" && item.packageChapterId === packageChapterId,
  );
}

function useShareImportSubmitState({
  availablePackageChapters,
  deletedExistingChapters,
  existingWorkId,
  leftItems,
  newSelections,
  newWorkTitle,
  targetMode,
}: ShareImportSubmitInput): {
  buildSubmitPayload: () => ShareImportModalSubmit;
  canSubmit: boolean;
} {
  const canSubmit = React.useMemo(
    () =>
      targetMode === "new"
        ? canSubmitNewWork(newWorkTitle, newSelections)
        : canSubmitExistingWork(existingWorkId, leftItems),
    [existingWorkId, leftItems, newSelections, newWorkTitle, targetMode],
  );
  const buildSubmitPayload = React.useCallback(
    () =>
      buildShareImportPayload({
        availablePackageChapters,
        deletedExistingChapters,
        existingWorkId,
        leftItems,
        newSelections,
        newWorkTitle,
        targetMode,
      }),
    [
      availablePackageChapters,
      deletedExistingChapters,
      existingWorkId,
      leftItems,
      newSelections,
      newWorkTitle,
      targetMode,
    ],
  );
  return { buildSubmitPayload, canSubmit };
}

function canSubmitNewWork(
  newWorkTitle: string,
  newSelections: NewSelection[],
): boolean {
  return Boolean(
    newWorkTitle.trim() &&
    newSelections.some((item) => item.enabled && item.title.trim()),
  );
}

function canSubmitExistingWork(
  existingWorkId: string,
  leftItems: LeftItem[],
): boolean {
  return Boolean(
    existingWorkId &&
    leftItems.length > 0 &&
    leftItems.every((item) => item.title.trim()),
  );
}

function buildShareImportPayload({
  availablePackageChapters,
  deletedExistingChapters,
  existingWorkId,
  leftItems,
  newSelections,
  newWorkTitle,
  targetMode,
}: ShareImportSubmitInput): ShareImportModalSubmit {
  if (targetMode === "new") {
    return buildNewWorkPayload(newWorkTitle, newSelections);
  }
  return {
    target: { mode: "existing", workId: existingWorkId },
    entries: leftItems.map(toImportEntry),
    remainingPackageChapters: availablePackageChapters,
    deletedExistingChapters,
  };
}

function buildNewWorkPayload(
  newWorkTitle: string,
  newSelections: NewSelection[],
): ShareImportModalSubmit {
  return {
    target: { mode: "new", title: newWorkTitle },
    entries: newSelections
      .filter((item) => item.enabled)
      .map(
        (item): WorkShareImportEntry => ({
          source: "package",
          packageChapterId: item.packageChapterId,
          title: item.title,
        }),
      ),
    remainingPackageChapters: [],
    deletedExistingChapters: [],
  };
}
