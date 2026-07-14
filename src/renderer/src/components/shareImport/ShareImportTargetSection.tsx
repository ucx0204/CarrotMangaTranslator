import React from "react";
import { useTranslation } from "react-i18next";
import type { LibraryIndex } from "../../../../shared/libraryTypes";
import type { WorkShareImportPreview } from "../../../../shared/shareTypes";
import { TextField } from "../ui/Field";
import { SelectionCard } from "../ui/SelectionCard";

type ShareImportTargetSectionProps = {
  busy: boolean;
  existingWorkId: string;
  library: LibraryIndex;
  newWorkTitle: string;
  preview: WorkShareImportPreview;
  setExistingWorkId: React.Dispatch<React.SetStateAction<string>>;
  setNewWorkTitle: React.Dispatch<React.SetStateAction<string>>;
  setTargetMode: React.Dispatch<React.SetStateAction<"new" | "existing">>;
  targetMode: "new" | "existing";
};

export function ShareImportTargetSection({
  busy,
  existingWorkId,
  library,
  newWorkTitle,
  preview,
  setExistingWorkId,
  setNewWorkTitle,
  setTargetMode,
  targetMode,
}: ShareImportTargetSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="modal-section share-target-section">
      <div className="share-package-title">
        <strong>{preview.workTitle}</strong>
        <span>
          {t("common.chapterCount", { count: preview.chapters.length })}
        </span>
      </div>
      <div className="share-target-grid">
        <SelectionCard
          className="share-target-card"
          inputType="radio"
          name="share-import-target-mode"
          checked={targetMode === "new"}
          disabled={busy}
          onChange={() => setTargetMode("new")}
        >
          <span>{t("import.createNewWork")}</span>
        </SelectionCard>
        <SelectionCard
          className="share-target-card"
          inputType="radio"
          name="share-import-target-mode"
          checked={targetMode === "existing"}
          disabled={busy || library.works.length === 0}
          onChange={() => setTargetMode("existing")}
        >
          <span>{t("shareImport.applyToExisting")}</span>
        </SelectionCard>
      </div>
      {targetMode === "new" ? (
        <TextField
          label={t("shareImport.newWorkTitle")}
          value={newWorkTitle}
          disabled={busy}
          onChange={(event) => setNewWorkTitle(event.target.value)}
        />
      ) : (
        <label>
          {t("shareImport.existingWork")}
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
      )}
    </section>
  );
}
