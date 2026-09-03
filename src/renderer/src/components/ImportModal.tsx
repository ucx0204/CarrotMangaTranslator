/* eslint-disable max-lines -- import target, chapter selection, and linked-folder confirmation compose one modal */
import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ImportCreateSelection,
  ImportPreviewResult,
} from "../../../shared/importTypes";
import type { LibraryIndex } from "../../../shared/libraryTypes";
import type { LinkedWorkspaceImportOptions } from "../../../shared/linkedWorkspaceTypes";
import type { ImportModalSubmit } from "../lib/importFlowTypes";
import {
  buildImportSubmitPayload,
  isImportSubmittable,
  type ImportTargetMode,
  updateSelectionEnabled,
  updateSelectionTitle,
} from "./importModalHelpers";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { TextField } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { SelectionCard, SelectionSurface } from "./ui/SelectionCard";
import { WorkSelect } from "./WorkSelect";
import { ImportLinkedWorkspaceSection } from "./ImportLinkedWorkspaceSection";
import { InlineMessage } from "./ui/InlineMessage";
import type { ImportModalFeedback } from "../lib/importFlowTypes";

type ImportModalProps = {
  library: LibraryIndex;
  currentWorkId?: string | null;
  preview: ImportPreviewResult;
  busy: boolean;
  initialDraft?: ImportModalSubmit | null;
  feedback?: ImportModalFeedback | null;
  onCancel: () => void;
  onEntered?: () => void;
  onSubmit: (payload: ImportModalSubmit) => void;
};

export function ImportModal({
  library,
  currentWorkId = null,
  preview,
  busy,
  initialDraft = null,
  feedback = null,
  onCancel,
  onEntered,
  onSubmit,
}: ImportModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const initial = resolveImportModalInitialState(
    library,
    currentWorkId,
    preview,
    initialDraft,
  );
  const [targetMode, setTargetMode] = React.useState<"new" | "existing">(
    initial.targetMode,
  );
  const [newWorkTitle, setNewWorkTitle] = React.useState(initial.newWorkTitle);
  const [existingWorkId, setExistingWorkId] = React.useState(
    initial.existingWorkId,
  );
  const [selections, setSelections] = React.useState<ImportCreateSelection[]>(
    initial.selections,
  );
  const [linkedWorkspace, setLinkedWorkspace] =
    React.useState<LinkedWorkspaceImportOptions>(initial.linkedWorkspace);

  const modalTitle = resolveImportModalTitle(t, preview.mode);
  const submittable = isImportSubmittable(
    targetMode,
    newWorkTitle,
    existingWorkId,
    selections,
  );
  const submitPayload = buildImportSubmitPayload(
    targetMode,
    newWorkTitle,
    existingWorkId,
    selections,
    linkedWorkspace,
  );

  return (
    <Modal
      title={modalTitle}
      onEntered={onEntered}
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <ImportModalFooter
          busy={busy}
          onCancel={onCancel}
          onSubmit={() => onSubmit(submitPayload)}
          previewMode={preview.mode}
          submittable={submittable}
        />
      }
    >
      <ImportModalContent
        busy={busy}
        currentWorkId={initial.currentWorkId}
        existingWorkId={existingWorkId}
        library={library}
        linkedWorkspace={linkedWorkspace}
        newWorkTitle={newWorkTitle}
        preview={preview}
        selections={selections}
        setExistingWorkId={setExistingWorkId}
        setLinkedWorkspace={setLinkedWorkspace}
        setNewWorkTitle={setNewWorkTitle}
        setSelections={setSelections}
        setTargetMode={setTargetMode}
        targetMode={targetMode}
        feedback={feedback}
      />
    </Modal>
  );
}

function ImportModalContent({
  busy,
  currentWorkId,
  existingWorkId,
  library,
  linkedWorkspace,
  newWorkTitle,
  preview,
  selections,
  setExistingWorkId,
  setLinkedWorkspace,
  setNewWorkTitle,
  setSelections,
  setTargetMode,
  targetMode,
  feedback,
}: {
  busy: boolean;
  currentWorkId: string | null;
  existingWorkId: string;
  library: LibraryIndex;
  linkedWorkspace: LinkedWorkspaceImportOptions;
  newWorkTitle: string;
  preview: ImportPreviewResult;
  selections: ImportCreateSelection[];
  setExistingWorkId: React.Dispatch<React.SetStateAction<string>>;
  setLinkedWorkspace: React.Dispatch<
    React.SetStateAction<LinkedWorkspaceImportOptions>
  >;
  setNewWorkTitle: React.Dispatch<React.SetStateAction<string>>;
  setSelections: React.Dispatch<React.SetStateAction<ImportCreateSelection[]>>;
  setTargetMode: React.Dispatch<React.SetStateAction<"new" | "existing">>;
  targetMode: "new" | "existing";
  feedback: ImportModalFeedback | null;
}): React.JSX.Element {
  return (
    <>
      {feedback ? (
        <InlineMessage variant={feedback.variant} title={feedback.message} />
      ) : null}
      <ImportExcludedPagesNotice preview={preview} />
      <ImportTargetSection
        busy={busy}
        existingWorkId={existingWorkId}
        currentWorkId={currentWorkId}
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
      <ImportLinkedWorkspaceSection
        busy={busy}
        options={linkedWorkspace}
        onChange={setLinkedWorkspace}
      />
    </>
  );
}

function ImportExcludedPagesNotice({
  preview,
}: {
  preview: ImportPreviewResult;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const excludedPages = preview.excludedPages ?? [];
  if (excludedPages.length === 0) return null;

  const visible = excludedPages
    .slice(0, 3)
    .map(({ chapterTitle, pageName }) => `${chapterTitle} / ${pageName}`)
    .join(", ");
  const remaining = excludedPages.length - 3;
  return (
    <InlineMessage
      variant="warning"
      title={t("import.excludedImagesTitle", { count: excludedPages.length })}
      detail={t("import.excludedImagesDetail", {
        files: visible,
        more:
          remaining > 0
            ? t("import.excludedImagesMore", { count: remaining })
            : "",
      })}
    />
  );
}

function resolveImportModalInitialState(
  library: LibraryIndex,
  currentWorkId: string | null,
  preview: ImportPreviewResult,
  initialDraft: ImportModalSubmit | null,
) {
  const currentWorkAvailable = Boolean(
    currentWorkId && library.works.some((work) => work.id === currentWorkId),
  );
  return {
    currentWorkId: currentWorkAvailable ? currentWorkId : null,
    existingWorkId: resolveInitialExistingWorkId(
      library,
      currentWorkId,
      currentWorkAvailable,
      initialDraft,
    ),
    targetMode: resolveInitialTargetMode(currentWorkAvailable, initialDraft),
    newWorkTitle: resolveInitialWorkTitle(preview, initialDraft),
    selections: resolveInitialSelections(preview, initialDraft),
    linkedWorkspace: initialDraft?.linkedWorkspace ?? {
      enabled: true,
      outputFormat: "source" as const,
      jpegQuality: 95,
      webpQuality: 90,
    },
  };
}

function resolveInitialExistingWorkId(
  library: LibraryIndex,
  currentWorkId: string | null,
  currentWorkAvailable: boolean,
  initialDraft: ImportModalSubmit | null,
): string {
  if (initialDraft?.target.mode === "existing") {
    return initialDraft.target.workId;
  }
  if (currentWorkAvailable) return currentWorkId ?? "";
  return library.works[0]?.id ?? "";
}

function resolveInitialTargetMode(
  currentWorkAvailable: boolean,
  initialDraft: ImportModalSubmit | null,
): ImportTargetMode {
  if (initialDraft) return initialDraft.target.mode;
  return currentWorkAvailable ? "existing" : "new";
}

function resolveInitialWorkTitle(
  preview: ImportPreviewResult,
  initialDraft: ImportModalSubmit | null,
): string {
  return initialDraft?.target.mode === "new"
    ? initialDraft.target.title
    : preview.suggestedWorkTitle;
}

function resolveInitialSelections(
  preview: ImportPreviewResult,
  initialDraft: ImportModalSubmit | null,
): ImportCreateSelection[] {
  return preview.chapters.map(
    (chapter) =>
      initialDraft?.selections.find(
        (selection) => selection.draftId === chapter.draftId,
      ) ?? {
        draftId: chapter.draftId,
        title: chapter.title,
        enabled: true,
      },
  );
}

function resolveImportModalTitle(
  t: ReturnType<typeof useTranslation>["t"],
  mode: ImportPreviewResult["mode"],
): string {
  return t(mode === "batch" ? "import.batchTitle" : "import.addToLibrary");
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
    <ModalActionBar
      actions={
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
      }
    />
  );
}

function ImportTargetSection({
  busy,
  currentWorkId,
  existingWorkId,
  library,
  newWorkTitle,
  setExistingWorkId,
  setNewWorkTitle,
  setTargetMode,
  targetMode,
}: {
  busy: boolean;
  currentWorkId: string | null;
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
          label={
            currentWorkId
              ? t("import.addToCurrentWork")
              : t("import.addToExistingWork")
          }
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
        <>
          {currentWorkId && existingWorkId === currentWorkId ? (
            <p className="import-current-target-note" role="status">
              {t("import.currentWorkDefault")}
            </p>
          ) : null}
          <ImportExistingWorkSelect
            busy={busy}
            existingWorkId={existingWorkId}
            library={library}
            setExistingWorkId={setExistingWorkId}
          />
        </>
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
    <SelectionCard
      className="share-target-card"
      inputType="radio"
      name="target-mode"
      checked={active}
      disabled={disabled}
      onChange={() => onChange(mode)}
    >
      <span>{label}</span>
    </SelectionCard>
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
      <WorkSelect
        ariaLabel={t("import.selectWork")}
        library={library}
        value={existingWorkId}
        disabled={busy || library.works.length === 0}
        onValueChange={setExistingWorkId}
      />
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
    <SelectionSurface
      className="draft-item selection-field-row"
      variant="row"
      selected={previewMode === "batch" ? selection.enabled : true}
      disabled={busy}
    >
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
    </SelectionSurface>
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
    <CheckboxField
      className="checkbox-row"
      ariaLabel={`${selection.title} · ${t("common.pageCount", { count: chapter.pages.length })}`}
      label={t("common.pageCount", { count: chapter.pages.length })}
      checked={selection.enabled}
      disabled={busy}
      onCheckedChange={(checked) =>
        updateSelectionEnabled(setSelections, chapter.draftId, checked)
      }
    />
  );
}
