import React from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "./ui";

export type TranslateSourceMode = "images" | "folder" | "zip";

type TranslateSourceModalProps = {
  busy: boolean;
  onCancel: () => void;
  onSelect: (mode: TranslateSourceMode) => void;
};

export function TranslateSourceModal({
  busy,
  onCancel,
  onSelect,
}: TranslateSourceModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Modal
      size="sm"
      ariaLabel={t("translateSource.title")}
      title={t("translateSource.title")}
      onClose={onCancel}
      closeDisabled={busy}
    >
      <div className="source-choice-grid">
        <Button onClick={() => onSelect("images")} disabled={busy}>
          {t("translateSource.openImages")}
        </Button>
        <Button onClick={() => onSelect("folder")} disabled={busy}>
          {t("translateSource.openFolder")}
        </Button>
        <Button onClick={() => onSelect("zip")} disabled={busy}>
          {t("translateSource.openArchive")}
        </Button>
      </div>
    </Modal>
  );
}
