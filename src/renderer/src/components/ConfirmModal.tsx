import React from "react";
import { useTranslation } from "react-i18next";
import type { ButtonProps } from "./ui/Button";
import { Modal, type ModalProps } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import { WarnIcon } from "./ui/icons";

export function AppModal(props: ModalProps): React.JSX.Element {
  return <Modal {...props} />;
}

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
  confirmVariant?: ButtonProps["variant"];
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
            <ModalActionButtons
              cancel={{ label: t("common.cancel"), onClick: onCancel }}
              confirm={{
                label: confirmLabel ?? t("common.confirm"),
                onClick: onConfirm,
                variant: confirmVariant,
              }}
            />
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
