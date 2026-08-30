import React from "react";
import type { LibraryIndex } from "../../../../shared/libraryTypes";
import type {
  WorkShareImportEntry,
  WorkShareImportPreview,
  WorkSharePreviewChapter,
} from "../../../../shared/shareTypes";
import type { ShareImportModalSubmit } from "../../lib/shareImportTypes";
import {
  buildExistingItems,
  toExistingItem,
  toImportEntry,
  toLeftPackageItem,
} from "./shareImportHelpers";
import type { ActiveDrag, LeftItem, NewSelection } from "./shareImportTypes";
import { createShareImportInitialState } from "./shareImportInitialState";

type ShareImportModalStateInput = {
  library: LibraryIndex;
  preview: WorkShareImportPreview;
  initialDraft?: ShareImportModalSubmit | null;
};

type SelectedWork = LibraryIndex["works"][number] | null;

type ShareImportSubmitInput = {
  candidateItems: LeftItem[];
  deletedExistingChapters: Array<{ id: string; title: string }>;
  existingWorkId: string;
  leftItems: LeftItem[];
  newSelections: NewSelection[];
  newWorkTitle: string;
  targetMode: "new" | "existing";
};

// eslint-disable-next-line max-lines-per-function -- paired package/existing lists must share one drag-and-submit state lifecycle
export function useShareImportModalState({
  library,
  preview,
  initialDraft = null,
}: ShareImportModalStateInput) {
  const initial = createShareImportInitialState(library, preview, initialDraft);
  const [targetMode, setTargetMode] = React.useState<"new" | "existing">(
    initial.targetMode,
  );
  const [newWorkTitle, setNewWorkTitle] = React.useState(initial.newWorkTitle);
  const [existingWorkId, setExistingWorkId] = React.useState(
    initial.existingWorkId,
  );
  const selectedWork = React.useMemo(
    () => library.works.find((work) => work.id === existingWorkId) ?? null,
    [existingWorkId, library.works],
  );
  const [newSelections, setNewSelections] = React.useState<NewSelection[]>(
    initial.newSelections,
  );
  const [leftItems, setLeftItems] = React.useState<LeftItem[]>(
    initial.leftItems,
  );
  const [candidateItems, setCandidateItems] = React.useState<LeftItem[]>(
    initial.candidateItems,
  );
  const [activeDrag, setActiveDrag] = React.useState<ActiveDrag | null>(null);
  const initialDraftRef = React.useRef(Boolean(initialDraft));

  useExistingTargetReset({
    initialDraftRef,
    previewChapters: preview.chapters,
    selectedWork,
    setCandidateItems,
    setLeftItems,
    targetMode,
  });

  const deletedExistingChapters = useDeletedExistingChapters(
    leftItems,
    selectedWork,
  );
  const { appendAllPackageChapters, appendPackageChapter } =
    usePackageChapterAppenders(candidateItems, setCandidateItems, setLeftItems);
  const { removeFinalItem, resetMerge, restoreExistingChapter } =
    useMergeListActions(
      selectedWork,
      preview.chapters,
      setCandidateItems,
      setLeftItems,
    );
  const { buildSubmitPayload, canSubmit } = useShareImportSubmitState({
    candidateItems,
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
    availablePackageChapters: candidateItems,
    buildSubmitPayload,
    canSubmit,
    deletedExistingChapters,
    existingWorkId,
    leftItems,
    newSelections,
    newWorkTitle,
    removeFinalItem,
    resetMerge,
    restoreExistingChapter,
    setActiveDrag,
    setCandidateItems,
    setExistingWorkId,
    setLeftItems,
    setNewSelections,
    setNewWorkTitle,
    setTargetMode,
    targetMode,
  };
}

function useExistingTargetReset({
  initialDraftRef,
  previewChapters,
  selectedWork,
  setCandidateItems,
  setLeftItems,
  targetMode,
}: {
  initialDraftRef: React.MutableRefObject<boolean>;
  previewChapters: WorkSharePreviewChapter[];
  selectedWork: SelectedWork;
  setCandidateItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>;
  targetMode: "new" | "existing";
}): void {
  React.useEffect(() => {
    if (targetMode !== "existing") return;
    if (initialDraftRef.current) {
      initialDraftRef.current = false;
      return;
    }
    setLeftItems(buildExistingItems(selectedWork));
    setCandidateItems(previewChapters.map(toLeftPackageItem));
  }, [
    initialDraftRef,
    previewChapters,
    selectedWork,
    setCandidateItems,
    setLeftItems,
    targetMode,
  ]);
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
  candidateItems: LeftItem[],
  setCandidateItems: React.Dispatch<React.SetStateAction<LeftItem[]>>,
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>,
): {
  appendAllPackageChapters: () => void;
  appendPackageChapter: (packageChapterId: string) => void;
} {
  const appendPackageChapter = React.useCallback(
    (packageChapterId: string) => {
      const item = candidateItems.find(
        (candidate) =>
          candidate.source === "package" &&
          candidate.packageChapterId === packageChapterId,
      );
      if (!item) {
        return;
      }
      setCandidateItems((current) =>
        current.filter((candidate) => candidate.key !== item.key),
      );
      setLeftItems((current) =>
        current.some((existing) => existing.key === item.key)
          ? current
          : [...current, item],
      );
    },
    [candidateItems, setCandidateItems, setLeftItems],
  );
  const appendAllPackageChapters = React.useCallback(() => {
    setLeftItems((current) => [
      ...current,
      ...candidateItems.filter(
        (candidate) =>
          !current.some((existing) => existing.key === candidate.key),
      ),
    ]);
    setCandidateItems([]);
  }, [candidateItems, setCandidateItems, setLeftItems]);
  return { appendAllPackageChapters, appendPackageChapter };
}

function useMergeListActions(
  selectedWork: SelectedWork,
  previewChapters: WorkSharePreviewChapter[],
  setCandidateItems: React.Dispatch<React.SetStateAction<LeftItem[]>>,
  setLeftItems: React.Dispatch<React.SetStateAction<LeftItem[]>>,
): {
  removeFinalItem: (item: LeftItem) => void;
  resetMerge: () => void;
  restoreExistingChapter: (chapterId: string) => void;
} {
  const removeFinalItem = React.useCallback(
    (item: LeftItem) => {
      setLeftItems((current) =>
        current.filter((candidate) => candidate.key !== item.key),
      );
      if (item.source === "package") {
        setCandidateItems((current) =>
          current.some((candidate) => candidate.key === item.key)
            ? current
            : [...current, item],
        );
      }
    },
    [setCandidateItems, setLeftItems],
  );
  const restoreExistingChapter = React.useCallback(
    (chapterId: string) => {
      const chapter = selectedWork?.chapters.find(
        (candidate) => candidate.id === chapterId,
      );
      if (!chapter) {
        return;
      }
      const restored = toExistingItem(chapter);
      setLeftItems((current) =>
        current.some((item) => item.key === restored.key)
          ? current
          : [...current, restored],
      );
    },
    [selectedWork, setLeftItems],
  );
  const resetMerge = React.useCallback(() => {
    setLeftItems(buildExistingItems(selectedWork));
    setCandidateItems(previewChapters.map(toLeftPackageItem));
  }, [previewChapters, selectedWork, setCandidateItems, setLeftItems]);
  return { removeFinalItem, resetMerge, restoreExistingChapter };
}

function useShareImportSubmitState({
  candidateItems,
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
        candidateItems,
        deletedExistingChapters,
        existingWorkId,
        leftItems,
        newSelections,
        newWorkTitle,
        targetMode,
      }),
    [
      candidateItems,
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
  candidateItems,
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
    remainingPackageChapters: candidateItems.flatMap((item) =>
      item.source === "package"
        ? [
            {
              packageChapterId: item.packageChapterId,
              title: item.title,
              pageCount: item.pageCount,
            },
          ]
        : [],
    ),
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
