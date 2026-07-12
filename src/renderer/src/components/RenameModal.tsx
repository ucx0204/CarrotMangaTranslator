import React from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal, TextField } from "./ui";

type RenameModalProps = {
  kind: "work" | "chapter";
  initialTitle: string;
  busy: boolean;
  onCancel: () => void;
  onDelete: () => void;
  onSubmit: (title: string) => void;
};

export function RenameModal({
  kind,
  initialTitle,
  busy,
  onCancel,
  onDelete,
  onSubmit,
}: RenameModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [title, setTitle] = React.useState(initialTitle);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = title.trim();
  const heading = t(
    kind === "work" ? "rename.workTitle" : "rename.chapterTitle",
  );
  const deleteLabel = t(
    kind === "work" ? "rename.deleteWork" : "rename.deleteChapter",
  );
  const deleteNote =
    kind === "work"
      ? t("rename.deleteWorkWarning")
      : t("rename.deleteChapterWarning");

  return (
    <Modal
      size="sm"
      ariaLabel={heading}
      title={heading}
      onClose={onCancel}
      closeDisabled={busy}
      footer={
        <>
          <Button
            variant="danger"
            className="modal-danger"
            onClick={onDelete}
            disabled={busy}
          >
            {deleteLabel}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => onSubmit(trimmed)}
            disabled={busy || !trimmed}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <TextField
        ref={inputRef}
        label={t("rename.newName")}
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
