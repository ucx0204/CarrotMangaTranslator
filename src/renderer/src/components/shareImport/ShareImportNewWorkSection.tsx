import React from "react";
import type { WorkShareImportPreview } from "../../../../shared/shareTypes";
import { Button } from "../ui";
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
  const selectAll = (): void => {
    setNewSelections((current) => updateAllSelections(current, true));
  };
  const clearAll = (): void => {
    setNewSelections((current) => updateAllSelections(current, false));
  };

  return (
    <section className="modal-section">
      <div className="modal-subheader">
        <h3>가져올 화</h3>
        <div className="inline-actions">
          <Button variant="ghost" size="sm" onClick={selectAll} disabled={busy}>
            전체 선택
          </Button>
          <Button variant="ghost" size="sm" onClick={clearAll} disabled={busy}>
            전체 해제
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
  return (
    <div className="draft-item">
      <label className="checkbox-row">
        <input
          type="checkbox"
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
        <span>{pageCount}페이지</span>
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
    </div>
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
