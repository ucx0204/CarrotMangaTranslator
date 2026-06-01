import React from "react";
import { Button, Modal, TextField } from "./ui";

type RenameModalProps = {
  kind: "work" | "chapter";
  initialTitle: string;
  busy: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onSubmit: (title: string) => void;
};

export function RenameModal({ kind, initialTitle, busy, onCancel, onDelete, onSubmit }: RenameModalProps): React.JSX.Element {
  const [title, setTitle] = React.useState(initialTitle);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = title.trim();
  const heading = kind === "work" ? "작품 이름 변경" : "화 이름 변경";
  const deleteLabel = kind === "work" ? "작품 삭제" : "화 삭제";
  const deleteNote =
    kind === "work"
      ? "작품을 삭제하면 포함된 모든 화, 페이지, 번역 결과가 함께 삭제됩니다."
      : "화를 삭제하면 포함된 페이지와 번역 결과가 함께 삭제됩니다.";

  return (
    <Modal
      size="sm"
      ariaLabel={heading}
      title={heading}
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <>
          <Button variant="danger" className="modal-danger" onClick={onDelete} disabled={busy}>
            {deleteLabel}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            취소
          </Button>
          <Button variant="primary" onClick={() => onSubmit(trimmed)} disabled={busy || !trimmed}>
            저장
          </Button>
        </>
      }
    >
      <TextField
        ref={inputRef}
        label="새 이름"
        value={title}
        disabled={busy}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && trimmed) {
            onSubmit(trimmed);
          }
        }}
      />
      <p className="muted-line modal-note">{deleteNote}</p>
    </Modal>
  );
}
