import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkShareImportPreview } from "../../../../shared/shareTypes";
import { Button } from "../ui/Button";
import { SelectionSurface } from "../ui/SelectionCard";
import type { NewSelection } from "./shareImportTypes";

type ShareImportNewWorkSectionProps = {
  busy: boolean;
  newSelections: NewSelection[];
  preview: WorkShareImportPreview;
  setNewSelections: React.Dispatch<React.SetStateAction<NewSelection[]>>;
};

export function ShareImportNewWorkSection({
  busy,
  newSelections,
  preview,
  setNewSelections,
}: ShareImportNewWorkSectionProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const selectAll = (): void => {
    setNewSelections((current) => updateAllSelections(current, true));
  };
  const clearAll = (): void => {
    setNewSelections((current) => updateAllSelections(current, false));
  };

  return (
    <section className="modal-section">
      <div className="modal-subheader">
        <h3>{t("shareImport.chaptersToImport")}</h3>
        <div className="inline-actions">
          <Button variant="ghost" size="sm" onClick={selectAll} disabled={busy}>
            {t("common.selectAll")}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearAll} disabled={busy}>
            {t("common.clearAll")}
          </Button>
        </div>
      </div>
      <div className="draft-list">
        {preview.chapters.map((chapter) => {
          const selection = newSelections.find(
            (item) => item.packageChapterId === chapter.packageChapterId,
          );
          if (!selection) {
            return null;
          }
          return (
            <ShareImportNewWorkItem
              key={chapter.packageChapterId}
              busy={busy}
              packageChapterId={chapter.packageChapterId}
              pageCount={chapter.pageCount}
              selection={selection}
              setNewSelections={setNewSelections}
            />
          );
        })}
      </div>
    </section>
  );
}

function ShareImportNewWorkItem({
  busy,
  packageChapterId,
  pageCount,
  selection,
  setNewSelections,
}: {
  busy: boolean;
  packageChapterId: string;
  pageCount: number;
  selection: NewSelection;
  setNewSelections: React.Dispatch<React.SetStateAction<NewSelection[]>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <SelectionSurface
      className="draft-item selection-field-row"
      variant="row"
      selected={selection.enabled}
      disabled={busy}
    >
      <label className="checkbox-row">
        <input
          type="checkbox"
          aria-label={`${selection.title} · ${t("common.pageCount", { count: pageCount })}`}
          checked={selection.enabled}
          disabled={busy}
          onChange={(event) => {
            setNewSelections((current) =>
              updateSelectionEnabled(
                current,
                packageChapterId,
                event.target.checked,
              ),
            );
          }}
        />
        <span>{t("common.pageCount", { count: pageCount })}</span>
      </label>
      <input
        value={selection.title}
        disabled={busy || !selection.enabled}
        onChange={(event) => {
          setNewSelections((current) =>
            updateSelectionTitle(current, packageChapterId, event.target.value),
          );
        }}
      />
    </SelectionSurface>
  );
}

function updateAllSelections(
  selections: NewSelection[],
  enabled: boolean,
): NewSelection[] {
  return selections.map((item) => ({ ...item, enabled }));
}

function updateSelectionEnabled(
  selections: NewSelection[],
  packageChapterId: string,
  enabled: boolean,
): NewSelection[] {
  return selections.map((item) =>
    item.packageChapterId === packageChapterId ? { ...item, enabled } : item,
  );
}

function updateSelectionTitle(
  selections: NewSelection[],
  packageChapterId: string,
  title: string,
): NewSelection[] {
  return selections.map((item) =>
    item.packageChapterId === packageChapterId ? { ...item, title } : item,
  );
}
