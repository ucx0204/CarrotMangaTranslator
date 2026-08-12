import React from "react";
import { useTranslation } from "react-i18next";
import type { PageImageExportFormat } from "../../../shared/pageImageExportTypes";
import { CheckboxField } from "./ui/CheckboxField";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import { Select } from "./ui/Select";

export function ExportRenderOptions({
  disabled,
  omitText,
  outputFormat,
  onOmitTextChange,
  onOutputFormatChange,
}: {
  disabled: boolean;
  omitText: boolean;
  outputFormat: PageImageExportFormat;
  onOmitTextChange: (checked: boolean) => void;
  onOutputFormatChange: (format: PageImageExportFormat) => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const formatHintKey =
    outputFormat === "psd"
      ? "exportOptions.formatHints.psd"
      : "exportOptions.formatHints.png";
  const omitTextHintKey =
    outputFormat === "psd"
      ? "exportOptions.omitTextHintPsd"
      : "exportOptions.omitTextHint";
  return (
    <section className="export-render-options">
      <div className="export-format-field">
        <span>{t("exportOptions.outputFormat")}</span>
        <Select
          ariaLabel={t("exportOptions.outputFormat")}
          disabled={disabled}
          value={outputFormat}
          options={[
            { value: "png", label: t("exportOptions.formats.png") },
            { value: "psd", label: t("exportOptions.formats.psd") },
          ]}
          onValueChange={(value) =>
            onOutputFormatChange(value as PageImageExportFormat)
          }
        />
      </div>
      <span>{t(formatHintKey)}</span>
      <CheckboxField
        checked={omitText}
        disabled={disabled}
        label={t("exportOptions.omitText")}
        onCheckedChange={onOmitTextChange}
      />
      <span>{t(omitTextHintKey)}</span>
    </section>
  );
}

export function ExportOptionsFooter({
  isStarting,
  startDisabled,
  onCancel,
  onStart,
  outputFormat,
}: {
  isStarting: boolean;
  startDisabled: boolean;
  onCancel: () => void;
  onStart: () => void;
  outputFormat: PageImageExportFormat;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const startLabel =
    outputFormat === "psd"
      ? t("exportOptions.startPsd")
      : t("exportOptions.start");
  return (
    <ModalActionBar
      actions={
        <ModalActionButtons
          cancel={{
            label: t("common.cancel"),
            onClick: onCancel,
            disabled: isStarting,
            variant: "secondary",
          }}
          confirm={{
            label: isStarting ? t("exportOptions.starting") : startLabel,
            onClick: onStart,
            disabled: isStarting || startDisabled,
          }}
        />
      }
    />
  );
}
