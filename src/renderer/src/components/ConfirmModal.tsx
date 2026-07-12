import React from "react";
import { useTranslation } from "react-i18next";
import { Button, Modal } from "./ui";
import { WarnIcon } from "./ui/icons";

export function ConfirmModal({
  title,
  message,
  detail,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  detail?: string;
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
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            {t("common.confirm")}
          </Button>
        </>
      }
    >
      <div className="confirm-body">
        <strong>{message}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
    </Modal>
  );
}
