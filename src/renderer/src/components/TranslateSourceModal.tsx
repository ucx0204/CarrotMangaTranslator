import React from "react";
import { Button, Modal } from "./ui";

export type TranslateSourceMode = "images" | "folder" | "zip";

type TranslateSourceModalProps = {
  busy: boolean;
  onCancel: () => void;
  onSelect: (mode: TranslateSourceMode) => void;
};

export function TranslateSourceModal({ busy, onCancel, onSelect }: TranslateSourceModalProps): React.JSX.Element {
  return (
    <Modal size="sm" ariaLabel="번역할 원본 선택" title="번역할 원본 선택" onClose={onCancel} closeDisabled={busy}>
      <div className="source-choice-grid">
        <Button onClick={() => onSelect("images")} disabled={busy}>
          이미지 열기
        </Button>
        <Button onClick={() => onSelect("folder")} disabled={busy}>
          폴더 열기
        </Button>
        <Button onClick={() => onSelect("zip")} disabled={busy}>
          압축파일 열기
        </Button>
      </div>
    </Modal>
  );
}
