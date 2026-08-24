import React from "react";
import { useTranslation } from "react-i18next";
import type { LibraryIndex } from "../../../shared/libraryTypes";
import type { WorkShareImportPreview } from "../../../shared/shareTypes";
import type { ShareImportModalSubmit } from "../lib/shareImportTypes";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { ShareImportExistingMergeSection } from "./shareImport/ShareImportExistingMergeSection";
import { ShareImportNewWorkSection } from "./shareImport/ShareImportNewWorkSection";
import { ShareImportTargetSection } from "./shareImport/ShareImportTargetSection";
import { useShareImportModalState } from "./shareImport/useShareImportModalState";

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
  const { t } = useTranslation("components");
  const state = useShareImportModalState({ library, preview });

  return (
    <Modal
      size="xl"
      title={t("sidebar.importWork")}
      onClose={onCancel}
      closeDisabled={busy}
      // Picking an existing work shows two panes that scroll on their own, so
      // the body fills the dialog instead of adding a second outer scrollbar.
      bodyLayout={state.targetMode === "existing" ? "fill" : "grid"}
      bodyClassName={
        state.targetMode === "existing" ? "share-import-modal-body" : undefined
      }
      footer={
        <ModalActionBar
          actions={
            <>
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                disabled={busy || !state.canSubmit}
                onClick={() => onSubmit(state.buildSubmitPayload())}
              >
                {t("shareImport.applyImport")}
              </Button>
            </>
          }
        />
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
