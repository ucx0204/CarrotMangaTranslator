import React from "react";
import type { WorkShareImportPreview } from "../../../../shared/types";
import { Button } from "../ui";

type NewSelection = {
  packageChapterId: string;
  title: string;
  enabled: boolean;
};

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
  return (
    <section className="modal-section">
      <div className="modal-subheader">
        <h3>가져올 화</h3>
        <div className="inline-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setNewSelections((current) =>
                current.map((item) => ({ ...item, enabled: true })),
              )
            }
            disabled={busy}
          >
            전체 선택
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setNewSelections((current) =>
                current.map((item) => ({ ...item, enabled: false })),
              )
            }
            disabled={busy}
          >
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
            <div key={chapter.packageChapterId} className="draft-item">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selection.enabled}
                  disabled={busy}
                  onChange={(event) => {
                    setNewSelections((current) =>
                      current.map((item) =>
                        item.packageChapterId === chapter.packageChapterId
                          ? { ...item, enabled: event.target.checked }
                          : item,
                      ),
                    );
                  }}
                />
                <span>{chapter.pageCount}페이지</span>
              </label>
              <input
                value={selection.title}
                disabled={busy || !selection.enabled}
                onChange={(event) => {
                  const title = event.target.value;
                  setNewSelections((current) =>
                    current.map((item) =>
                      item.packageChapterId === chapter.packageChapterId
                        ? { ...item, title }
                        : item,
                    ),
                  );
                }}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
