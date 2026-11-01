import React from "react";
import { useTranslation } from "react-i18next";
import { CheckboxField } from "./ui/CheckboxField";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";

export function TranslationOptionsActionBar({
  onCancel,
  onSaveAsDefaultChange,
  onStart,
  saveAsDefault,
  startDisabled = false,
  startLabel,
}: {
  onCancel: () => void;
  onSaveAsDefaultChange: (value: boolean) => void;
  onStart: () => void;
  saveAsDefault: boolean;
  startDisabled?: boolean;
  startLabel: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      leading={
        <CheckboxField
          className="translation-save-defaults"
          label={t("translationOptions.saveAsDefault")}
          checked={saveAsDefault}
          onCheckedChange={onSaveAsDefaultChange}
        />
      }
      actions={
        <ModalActionButtons
          cancel={{ label: t("common.cancel"), onClick: onCancel }}
          confirm={{
            label: startLabel,
            onClick: onStart,
            disabled: startDisabled,
          }}
        />
      }
    />
  );
}
