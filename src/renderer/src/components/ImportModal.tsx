import React from "react";
import type {
  ImportCreateSelection,
  ImportPreviewResult,
} from "../../../shared/importTypes";
import type { LibraryIndex } from "../../../shared/libraryTypes";
import { Button, Modal, TextField } from "./ui";

export type ImportModalSubmit = {
  target:
    | {
        mode: "new";
        title: string;
      }
    | {
        mode: "existing";
        workId: string;
      };
  selections: ImportCreateSelection[];
};

type ImportModalProps = {
  library: LibraryIndex;
  preview: ImportPreviewResult;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: ImportModalSubmit) => void;
};

type ImportTargetMode = "new" | "existing";

export function ImportModal({
  library,
  preview,
  busy,
  onCancel,
  onSubmit,
}: ImportModalProps): React.JSX.Element {
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

  const modalTitle = resolveImportModalTitle(preview.mode);
  const submittable = isSubmittable(
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
  return (
    <>
      <Button variant="ghost" onClick={onCancel} disabled={busy}>
        취소
      </Button>
      <Button
        variant="primary"
        disabled={busy || !submittable}
        onClick={onSubmit}
      >
        {previewMode === "batch" ? "생성 후 번역 시작" : "보관함에 추가"}
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
  return (
    <section className="modal-section share-target-section">
      <div className="share-target-grid">
        <ImportTargetModeCard
          active={targetMode === "new"}
          disabled={busy}
          label="새 작품 만들기"
          mode="new"
          onChange={setTargetMode}
        />
        <ImportTargetModeCard
          active={targetMode === "existing"}
          disabled={busy || library.works.length === 0}
          label="기존 작품에 추가"
          mode="existing"
          onChange={setTargetMode}
        />
      </div>
      {targetMode === "new" ? (
        <TextField
          label="작품 제목"
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
  return (
    <label>
      작품 선택
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
  return (
    <section className="modal-section">
      <h3>{preview.mode === "batch" ? "생성할 화" : "화 제목"}</h3>
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
        <span className="draft-meta">{chapter.pages.length}페이지</span>
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
      <span>{chapter.pages.length}페이지</span>
    </label>
  );
}

function updateSelectionEnabled(
  setSelections: React.Dispatch<React.SetStateAction<ImportCreateSelection[]>>,
  draftId: string,
  enabled: boolean,
): void {
  setSelections((current) =>
    current.map((item) =>
      item.draftId === draftId ? { ...item, enabled } : item,
    ),
  );
}

function updateSelectionTitle(
  setSelections: React.Dispatch<React.SetStateAction<ImportCreateSelection[]>>,
  draftId: string,
  title: string,
): void {
  setSelections((current) =>
    current.map((item) =>
      item.draftId === draftId ? { ...item, title } : item,
    ),
  );
}

function buildImportSubmitPayload(
  targetMode: ImportTargetMode,
  newWorkTitle: string,
  existingWorkId: string,
  selections: ImportCreateSelection[],
): ImportModalSubmit {
  return {
    target:
      targetMode === "new"
        ? { mode: "new", title: newWorkTitle }
        : { mode: "existing", workId: existingWorkId },
    selections,
  };
}

function resolveImportModalTitle(mode: ImportPreviewResult["mode"]): string {
  return mode === "batch" ? "작품 일괄 번역 준비" : "보관함에 추가";
}

function isSubmittable(
  targetMode: ImportTargetMode,
  newWorkTitle: string,
  existingWorkId: string,
  selections: ImportCreateSelection[],
): boolean {
  if (targetMode === "new" && !newWorkTitle.trim()) {
    return false;
  }
  if (targetMode === "existing" && !existingWorkId) {
    return false;
  }
  return selections.some(
    (selection) => selection.enabled && selection.title.trim(),
  );
}
