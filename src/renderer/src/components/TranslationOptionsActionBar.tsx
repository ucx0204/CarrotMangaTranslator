import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { ModalActionBar } from "./ui/ModalActionBar";

export function TranslationOptionsActionBar({
  showSaveAsDefault = true,
  onCancel,
  onSaveAsDefaultChange,
  onStart,
  saveAsDefault,
  startDisabled = false,
  startLabel,
}: {
  showSaveAsDefault?: boolean;
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
        showSaveAsDefault ? (
          <CheckboxField
            className="translation-save-defaults"
            label={t("translationOptions.saveAsDefault")}
            checked={saveAsDefault}
            onCheckedChange={onSaveAsDefaultChange}
          />
        ) : null
      }
      actions={
        <>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={onStart} disabled={startDisabled}>
            {startLabel}
          </Button>
        </>
      }
    />
  );
}
