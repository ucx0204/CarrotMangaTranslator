import React from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../ui/Modal";
import { ModalActionBar } from "../ui/ModalActionBar";
import { Button } from "../ui/Button";

export function RedactionExitDialog({
  busy,
  onClose,
  onSave,
  onDiscard,
}: {
  busy: boolean;
  onClose: () => void;
  onSave: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Modal
      title={t("manualRedaction.exitTitle")}
      size="sm"
      onClose={onClose}
      closeDisabled={busy}
      footer={
        <ModalActionBar
          actions={
            <>
              <Button disabled={busy} onClick={onClose}>
                {t("manualRedaction.keepEditing")}
              </Button>
              <Button variant="danger" disabled={busy} onClick={onDiscard}>
                {t("manualRedaction.discardSession")}
              </Button>
              <Button variant="primary" disabled={busy} onClick={onSave}>
                {t("manualRedaction.saveExit")}
              </Button>
            </>
          }
        />
      }
    >
      <p>{t("manualRedaction.exitHint")}</p>
    </Modal>
  );
}
