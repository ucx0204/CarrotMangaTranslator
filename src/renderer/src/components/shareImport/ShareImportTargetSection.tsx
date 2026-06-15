import React from "react";
import type {
  LibraryIndex,
  WorkShareImportPreview,
} from "../../../../shared/types";
import { TextField } from "../ui";

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
  return (
    <section className="modal-section share-target-section">
      <div className="share-package-title">
        <strong>{preview.workTitle}</strong>
        <span>{preview.chapters.length}개 화</span>
      </div>
      <div className="share-target-grid">
        <label
          className={`share-target-card ${targetMode === "new" ? "active" : ""}`}
        >
          <input
            type="radio"
            checked={targetMode === "new"}
            disabled={busy}
            onChange={() => setTargetMode("new")}
          />
          <span>새 작품 만들기</span>
        </label>
        <label
          className={`share-target-card ${targetMode === "existing" ? "active" : ""}`}
        >
          <input
            type="radio"
            checked={targetMode === "existing"}
            disabled={busy || library.works.length === 0}
            onChange={() => setTargetMode("existing")}
          />
          <span>기존 작품에 적용</span>
        </label>
      </div>
      {targetMode === "new" ? (
        <TextField
          label="새 작품 제목"
          value={newWorkTitle}
          disabled={busy}
          onChange={(event) => setNewWorkTitle(event.target.value)}
        />
      ) : (
        <label>
          기존 작품
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
