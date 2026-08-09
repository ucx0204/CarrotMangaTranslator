import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { WarnIcon } from "./ui/icons";

export function ConfirmModal({
  title,
  message,
  detail,
  confirmLabel,
  confirmVariant = "primary",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  detail?: string;
  confirmLabel?: string;
  confirmVariant?: React.ComponentProps<typeof Button>["variant"];
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <Modal
      size="sm"
      ariaLabel={title}
      onClose={onCancel}
      title={
        <span className="confirm-title-row">
          <span className="confirm-warning-icon" aria-hidden="true">
            <WarnIcon size={16} />
          </span>
          {title}
        </span>
      }
      footer={
        <ModalActionBar
          actions={
            <>
              <Button variant="ghost" onClick={onCancel}>
                {t("common.cancel")}
              </Button>
              <Button variant={confirmVariant} onClick={onConfirm}>
                {confirmLabel ?? t("common.confirm")}
              </Button>
            </>
          }
        />
      }
    >
      <div className="confirm-body">
        <strong>{message}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
    </Modal>
  );
}
