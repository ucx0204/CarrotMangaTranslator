import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ImportCreateSelection,
  ImportPreviewResult,
} from "../../../shared/importTypes";
import type { LibraryIndex } from "../../../shared/libraryTypes";
import type { ImportModalSubmit } from "../lib/importFlowTypes";
import {
  buildImportSubmitPayload,
  isImportSubmittable,
  type ImportTargetMode,
  updateSelectionEnabled,
  updateSelectionTitle,
} from "./importModalHelpers";
import { Button, Modal, TextField } from "./ui";

type ImportModalProps = {
  library: LibraryIndex;
  preview: ImportPreviewResult;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: ImportModalSubmit) => void;
};

export function ImportModal({
  library,
  preview,
  busy,
  onCancel,
  onSubmit,
}: ImportModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [targetMode, setTargetMode] = React.useState<"new" | "existing">(
    library.works.length ? "new" : "new",
  );
  const [newWorkTitle, setNewWorkTitle] = React.useState(
    preview.suggestedWorkTitle,
  );
  const [existingWorkId, setExistingWorkId] = React.useState(
    library.works[0]?.id ?? "",
  );
  const [selections, setSelections] = React.useState<ImportCreateSelection[]>(
    preview.chapters.map((chapter) => ({
      draftId: chapter.draftId,
      title: chapter.title,
      enabled: true,
    })),
  );

  const modalTitle = t(
    preview.mode === "batch" ? "import.batchTitle" : "import.addToLibrary",
  );
  const submittable = isImportSubmittable(
    targetMode,
    newWorkTitle,
    existingWorkId,
    selections,
  );

  return (
    <Modal
      ariaLabel={modalTitle}
      title={modalTitle}
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <ImportModalFooter
          busy={busy}
          onCancel={onCancel}
          onSubmit={() =>
            onSubmit(
              buildImportSubmitPayload(
                targetMode,
                newWorkTitle,
                existingWorkId,
                selections,
              ),
            )
          }
          previewMode={preview.mode}
          submittable={submittable}
        />
      }
    >
      <ImportTargetSection
        busy={busy}
        existingWorkId={existingWorkId}
        library={library}
        newWorkTitle={newWorkTitle}
        setExistingWorkId={setExistingWorkId}
        setNewWorkTitle={setNewWorkTitle}
        setTargetMode={setTargetMode}
        targetMode={targetMode}
      />
      <ImportDraftSection
        busy={busy}
        preview={preview}
        selections={selections}
        setSelections={setSelections}
      />
    </Modal>
  );
}

function ImportModalFooter({
  busy,
  onCancel,
  onSubmit,
  previewMode,
  submittable,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  previewMode: ImportPreviewResult["mode"];
  submittable: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        {t("common.cancel")}
      </Button>
      <Button
        variant="primary"
        disabled={busy || !submittable}
        onClick={onSubmit}
      >
        {t(
          previewMode === "batch"
            ? "import.createAndTranslate"
            : "import.addToLibrary",
        )}
      </Button>
    </>
  );
}

function ImportTargetSection({
  busy,
  existingWorkId,
  library,
  newWorkTitle,
  setExistingWorkId,
  setNewWorkTitle,
  setTargetMode,
  targetMode,
}: {
  busy: boolean;
  existingWorkId: string;
  library: LibraryIndex;
  newWorkTitle: string;
  setExistingWorkId: React.Dispatch<React.SetStateAction<string>>;
  setNewWorkTitle: React.Dispatch<React.SetStateAction<string>>;
  setTargetMode: React.Dispatch<React.SetStateAction<ImportTargetMode>>;
  targetMode: ImportTargetMode;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="modal-section share-target-section">
      <div className="share-target-grid">
        <ImportTargetModeCard
          active={targetMode === "new"}
          disabled={busy}
          label={t("import.createNewWork")}
          mode="new"
          onChange={setTargetMode}
        />
        <ImportTargetModeCard
          active={targetMode === "existing"}
          disabled={busy || library.works.length === 0}
          label={t("import.addToExistingWork")}
          mode="existing"
          onChange={setTargetMode}
        />
      </div>
      {targetMode === "new" ? (
        <TextField
          label={t("common.workTitle")}
          value={newWorkTitle}
          disabled={busy}
          onChange={(event) => setNewWorkTitle(event.target.value)}
        />
      ) : (
        <ImportExistingWorkSelect
          busy={busy}
          existingWorkId={existingWorkId}
          library={library}
          setExistingWorkId={setExistingWorkId}
        />
      )}
    </section>
  );
}

function ImportTargetModeCard({
  active,
  disabled,
  label,
  mode,
  onChange,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  mode: ImportTargetMode;
  onChange: React.Dispatch<React.SetStateAction<ImportTargetMode>>;
}): React.JSX.Element {
  return (
    <label className={`share-target-card ${active ? "active" : ""}`}>
      <input
        type="radio"
        name="target-mode"
        checked={active}
        disabled={disabled}
        onChange={() => onChange(mode)}
      />
      <span>{label}</span>
    </label>
  );
}

function ImportExistingWorkSelect({
  busy,
  existingWorkId,
  library,
  setExistingWorkId,
}: {
  busy: boolean;
  existingWorkId: string;
  library: LibraryIndex;
  setExistingWorkId: React.Dispatch<React.SetStateAction<string>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <label>
      {t("import.selectWork")}
      <select
        value={existingWorkId}
        disabled={busy || library.works.length === 0}
        onChange={(event) => setExistingWorkId(event.target.value)}
      >
        {library.works.map((work) => (
          <option key={work.id} value={work.id}>
            {work.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function ImportDraftSection({
  busy,
  preview,
  selections,
  setSelections,
}: {
  busy: boolean;
  preview: ImportPreviewResult;
  selections: ImportCreateSelection[];
  setSelections: React.Dispatch<React.SetStateAction<ImportCreateSelection[]>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="modal-section">
      <h3>
        {t(
          preview.mode === "batch"
            ? "import.chaptersToCreate"
            : "import.chapterTitle",
        )}
      </h3>
      <div className="draft-list">
        {preview.chapters.map((chapter) => {
          const selection = selections.find(
            (item) => item.draftId === chapter.draftId,
          );
          return selection ? (
            <ImportDraftItem
              key={chapter.draftId}
              busy={busy}
              chapter={chapter}
              previewMode={preview.mode}
              selection={selection}
              setSelections={setSelections}
            />
          ) : null;
        })}
      </div>
    </section>
  );
}

function ImportDraftItem({
  busy,
  chapter,
  previewMode,
  selection,
  setSelections,
}: {
  busy: boolean;
  chapter: ImportPreviewResult["chapters"][number];
  previewMode: ImportPreviewResult["mode"];
  selection: ImportCreateSelection;
  setSelections: React.Dispatch<React.SetStateAction<ImportCreateSelection[]>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="draft-item">
      {previewMode === "batch" ? (
        <ImportDraftBatchToggle
          busy={busy}
          chapter={chapter}
          selection={selection}
          setSelections={setSelections}
        />
      ) : (
        <span className="draft-meta">
          {t("common.pageCount", { count: chapter.pages.length })}
        </span>
      )}
      <input
        value={selection.title}
        disabled={busy || (previewMode === "batch" && !selection.enabled)}
        onChange={(event) =>
          updateSelectionTitle(
            setSelections,
            chapter.draftId,
            event.target.value,
          )
        }
      />
    </div>
  );
}

function ImportDraftBatchToggle({
  busy,
  chapter,
  selection,
  setSelections,
}: {
  busy: boolean;
  chapter: ImportPreviewResult["chapters"][number];
  selection: ImportCreateSelection;
  setSelections: React.Dispatch<React.SetStateAction<ImportCreateSelection[]>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <label className="checkbox-row">
      <input
        type="checkbox"
        checked={selection.enabled}
        disabled={busy}
        onChange={(event) =>
          updateSelectionEnabled(
            setSelections,
            chapter.draftId,
            event.target.checked,
          )
        }
      />
      <span>{t("common.pageCount", { count: chapter.pages.length })}</span>
    </label>
  );
}
