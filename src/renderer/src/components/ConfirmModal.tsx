import React from "react";
import { useTranslation } from "react-i18next";
import type { ButtonProps } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import { CheckboxField } from "./ui/CheckboxField";
import styles from "./ConfirmModal.module.css";

export function ConfirmModal({
  title,
  message,
  detail,
  option,
  confirmLabel,
  confirmVariant = "primary",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  detail?: string;
  option?: {
    label: string;
    confirmLabel?: string;
    destructive?: boolean;
    checked: boolean;
    onChange: (checked: boolean) => void;
  };
  confirmLabel?: string;
  confirmVariant?: ButtonProps["variant"];
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const [checked, setChecked] = React.useState(option?.checked ?? false);
  React.useEffect(() => setChecked(option?.checked ?? false), [option]);
  return (
    <Modal
      size="sm"
      onClose={onCancel}
      title={title}
      footer={
        <ModalActionBar
          actions={
            <ModalActionButtons
              cancel={{ label: t("common.cancel"), onClick: onCancel }}
              confirm={{
                label:
                  confirmLabel ?? option?.confirmLabel ?? t("common.confirm"),
                onClick: onConfirm,
                variant: option?.destructive ? "danger" : confirmVariant,
              }}
            />
          }
        />
      }
    >
      <div className={styles.body}>
        <strong className={styles.message}>{message}</strong>
        {detail ? <p className={styles.detail}>{detail}</p> : null}
        {option ? (
          <CheckboxField
            className={styles.option}
            label={option.label}
            checked={checked}
            onCheckedChange={(value) => {
              setChecked(value);
              option.onChange(value);
            }}
          />
        ) : null}
      </div>
    </Modal>
  );
}
