import React from "react";

export type TranslateSourceMode = "images" | "folder" | "zip";

type TranslateSourceModalProps = {
  busy: boolean;
  onCancel: () => void;
  onSelect: (mode: TranslateSourceMode) => void;
};

export function TranslateSourceModal({ busy, onCancel, onSelect }: TranslateSourceModalProps): React.JSX.Element {
  return (
    <div className="modal-backdrop">
      <div className="modal-card translate-source-modal">
        <div className="modal-header">
          <h2>번역할 원본 선택</h2>
          <button className="ghost-button" onClick={onCancel} disabled={busy}>
            닫기
          </button>
        </div>

        <div className="source-choice-grid">
          <button onClick={() => onSelect("images")} disabled={busy}>
            이미지 열기
          </button>
          <button onClick={() => onSelect("folder")} disabled={busy}>
            폴더 열기
          </button>
          <button onClick={() => onSelect("zip")} disabled={busy}>
            압축파일 열기
          </button>
        </div>
      </div>
    </div>
  );
}
