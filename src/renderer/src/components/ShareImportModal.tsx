import React from "react";
import type {
  LibraryIndex,
  WorkShareImportEntry,
  WorkShareImportPreview,
  WorkSharePreviewChapter,
} from "../../../shared/types";
import { Button, Modal } from "./ui";
import { ShareImportExistingMergeSection } from "./shareImport/ShareImportExistingMergeSection";
import { ShareImportNewWorkSection } from "./shareImport/ShareImportNewWorkSection";
import { ShareImportTargetSection } from "./shareImport/ShareImportTargetSection";
import {
  buildExistingItems,
  toImportEntry,
  toLeftPackageItem,
} from "./shareImport/shareImportHelpers";
import type {
  ActiveDrag,
  LeftItem,
  ShareImportModalSubmit,
} from "./shareImport/shareImportTypes";

export type { ShareImportModalSubmit } from "./shareImport/shareImportTypes";

type ShareImportModalProps = {
  library: LibraryIndex;
  preview: WorkShareImportPreview;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: ShareImportModalSubmit) => void;
};

type NewSelection = {
  packageChapterId: string;
  title: string;
  enabled: boolean;
};

export function ShareImportModal({
  library,
  preview,
  busy,
  onCancel,
  onSubmit,
}: ShareImportModalProps): React.JSX.Element {
  const [targetMode, setTargetMode] = React.useState<"new" | "existing">("new");
  const [newWorkTitle, setNewWorkTitle] = React.useState(preview.workTitle);
  const [existingWorkId, setExistingWorkId] = React.useState(
    library.works[0]?.id ?? "",
  );
  const selectedWork = React.useMemo(
    () => library.works.find((work) => work.id === existingWorkId) ?? null,
    [existingWorkId, library.works],
  );
  const [newSelections, setNewSelections] = React.useState<NewSelection[]>(
    preview.chapters.map((chapter) => ({
      packageChapterId: chapter.packageChapterId,
      title: chapter.title,
      enabled: true,
    })),
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

  const availablePackageChapters = React.useMemo(
    () =>
      preview.chapters.filter(
        (chapter) =>
          !leftItems.some(
            (item) =>
              item.source === "package" &&
              item.packageChapterId === chapter.packageChapterId,
          ),
      ),
    [leftItems, preview.chapters],
  );

  const deletedExistingChapters = React.useMemo(
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

  const appendPackageChapter = React.useCallback(
    (packageChapterId: string) => {
      setLeftItems((current) => {
        const chapter = preview.chapters.find(
          (candidate) => candidate.packageChapterId === packageChapterId,
        );
        if (
          !chapter ||
          current.some(
            (item) =>
              item.source === "package" &&
              item.packageChapterId === packageChapterId,
          )
        ) {
          return current;
        }
        return [...current, toLeftPackageItem(chapter)];
      });
    },
    [preview.chapters],
  );

  const appendAllPackageChapters = React.useCallback(() => {
    setLeftItems((current) => [
      ...current,
      ...preview.chapters
        .filter(
          (chapter) =>
            !current.some(
              (item) =>
                item.source === "package" &&
                item.packageChapterId === chapter.packageChapterId,
            ),
        )
        .map(toLeftPackageItem),
    ]);
  }, [preview.chapters]);

  const canSubmit = React.useCallback((): boolean => {
    if (targetMode === "new") {
      return Boolean(
        newWorkTitle.trim() &&
        newSelections.some((item) => item.enabled && item.title.trim()),
      );
    }
    return Boolean(
      existingWorkId &&
      leftItems.length > 0 &&
      leftItems.every((item) => item.title.trim()),
    );
  }, [existingWorkId, leftItems, newSelections, newWorkTitle, targetMode]);

  const buildSubmitPayload = React.useCallback((): ShareImportModalSubmit => {
    if (targetMode === "new") {
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

    return {
      target: { mode: "existing", workId: existingWorkId },
      entries: leftItems.map(toImportEntry),
      remainingPackageChapters:
        availablePackageChapters as WorkSharePreviewChapter[],
      deletedExistingChapters,
    };
  }, [
    availablePackageChapters,
    deletedExistingChapters,
    existingWorkId,
    leftItems,
    newSelections,
    newWorkTitle,
    targetMode,
  ]);

  return (
    <Modal
      size="xl"
      ariaLabel="가져오기"
      title="가져오기"
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={busy || !canSubmit()}
            onClick={() => onSubmit(buildSubmitPayload())}
          >
            가져오기 적용
          </Button>
        </>
      }
    >
      <ShareImportTargetSection
        busy={busy}
        existingWorkId={existingWorkId}
        library={library}
        newWorkTitle={newWorkTitle}
        preview={preview}
        setExistingWorkId={setExistingWorkId}
        setNewWorkTitle={setNewWorkTitle}
        setTargetMode={setTargetMode}
        targetMode={targetMode}
      />

      {targetMode === "new" ? (
        <ShareImportNewWorkSection
          busy={busy}
          newSelections={newSelections}
          preview={preview}
          setNewSelections={setNewSelections}
        />
      ) : (
        <ShareImportExistingMergeSection
          activeDrag={activeDrag}
          appendAllPackageChapters={appendAllPackageChapters}
          appendPackageChapter={appendPackageChapter}
          availablePackageChapters={availablePackageChapters}
          busy={busy}
          deletedExistingChapters={deletedExistingChapters}
          leftItems={leftItems}
          previewChapters={preview.chapters}
          setActiveDrag={setActiveDrag}
          setLeftItems={setLeftItems}
        />
      )}
    </Modal>
  );
}
