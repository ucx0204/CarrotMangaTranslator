import React from "react";
import type { LibraryIndex } from "../../../shared/libraryTypes";
import type { WorkShareImportPreview } from "../../../shared/shareTypes";
import { Button, Modal } from "./ui";
import { ShareImportExistingMergeSection } from "./shareImport/ShareImportExistingMergeSection";
import { ShareImportNewWorkSection } from "./shareImport/ShareImportNewWorkSection";
import { ShareImportTargetSection } from "./shareImport/ShareImportTargetSection";
import type { ShareImportModalSubmit } from "./shareImport/shareImportTypes";
import { useShareImportModalState } from "./shareImport/useShareImportModalState";

export type { ShareImportModalSubmit } from "./shareImport/shareImportTypes";

type ShareImportModalProps = {
  library: LibraryIndex;
  preview: WorkShareImportPreview;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: ShareImportModalSubmit) => void;
};

export function ShareImportModal({
  library,
  preview,
  busy,
  onCancel,
  onSubmit,
}: ShareImportModalProps): React.JSX.Element {
  const state = useShareImportModalState({ library, preview });

  return (
    <Modal
      size="xl"
      ariaLabel="가져오기"
      title="가져오기"
      onClose={onCancel}
      closeDisabled={busy}
      bodyClassName={
        state.targetMode === "existing" ? "share-import-modal-body" : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            취소
          </Button>
          <Button
            variant="primary"
            disabled={busy || !state.canSubmit}
            onClick={() => onSubmit(state.buildSubmitPayload())}
          >
            가져오기 적용
          </Button>
        </>
      }
    >
      <ShareImportTargetSection
        busy={busy}
        existingWorkId={state.existingWorkId}
        library={library}
        newWorkTitle={state.newWorkTitle}
        preview={preview}
        setExistingWorkId={state.setExistingWorkId}
        setNewWorkTitle={state.setNewWorkTitle}
        setTargetMode={state.setTargetMode}
        targetMode={state.targetMode}
      />

      {state.targetMode === "new" ? (
        <ShareImportNewWorkSection
          busy={busy}
          newSelections={state.newSelections}
          preview={preview}
          setNewSelections={state.setNewSelections}
        />
      ) : (
        <ShareImportExistingMergeSection
          activeDrag={state.activeDrag}
          appendAllPackageChapters={state.appendAllPackageChapters}
          appendPackageChapter={state.appendPackageChapter}
          availablePackageChapters={state.availablePackageChapters}
          busy={busy}
          deletedExistingChapters={state.deletedExistingChapters}
          leftItems={state.leftItems}
          removeFinalItem={state.removeFinalItem}
          resetMerge={state.resetMerge}
          restoreExistingChapter={state.restoreExistingChapter}
          setActiveDrag={state.setActiveDrag}
          setCandidateItems={state.setCandidateItems}
          setLeftItems={state.setLeftItems}
        />
      )}
    </Modal>
  );
}
