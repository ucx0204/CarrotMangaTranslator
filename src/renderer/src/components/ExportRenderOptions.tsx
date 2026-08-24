import React from "react";
import { useTranslation } from "react-i18next";
import type { PageImageExportFormat } from "../../../shared/pageImageExportTypes";
import type {
  ManualPsdExportOptions,
  ManualRasterExportOptions,
} from "../hooks/useExportPageImagesAction";
import { CheckboxField } from "./ui/CheckboxField";
import { ModalActionBar, ModalActionButtons } from "./ui/ModalActionBar";
import { NumberField } from "./ui/NumberField";
import { Select } from "./ui/Select";

export type ExportModalKind = "raster" | "psd";

export function ExportRenderOptions({
  disabled,
  kind,
  options,
  onChange,
}: {
  disabled: boolean;
  kind: ExportModalKind;
  options: ManualRasterExportOptions | ManualPsdExportOptions;
  onChange: (
    options: ManualRasterExportOptions | ManualPsdExportOptions,
  ) => void;
}): React.JSX.Element {
  return kind === "psd" ? (
    <PsdRenderOptions
      disabled={disabled}
      options={options}
      onChange={onChange}
    />
  ) : (
    <RasterRenderOptions
      disabled={disabled}
      options={options as ManualRasterExportOptions}
      onChange={onChange}
    />
  );
}

type RenderOptionProps<T> = {
  disabled: boolean;
  options: T;
  onChange: (
    options: ManualRasterExportOptions | ManualPsdExportOptions,
  ) => void;
};

function PsdRenderOptions({
  disabled,
  onChange,
  options,
}: RenderOptionProps<ManualPsdExportOptions>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <section className="export-render-options export-render-options-psd">
      <CheckboxField
        checked={options.omitText === true}
        disabled={disabled}
        label={t("exportOptions.omitText")}
        onCheckedChange={(omitText) => onChange({ ...options, omitText })}
      />
      <span>{t("exportOptions.omitTextHintPsd")}</span>
    </section>
  );
}

function RasterRenderOptions({
  disabled,
  onChange,
  options,
}: RenderOptionProps<ManualRasterExportOptions>): React.JSX.Element {
  const format = options.outputFormat ?? "source";
  return (
    <section className="export-render-options export-render-options-raster">
      <RasterFormatFields
        disabled={disabled}
        format={format}
        options={options}
        onChange={onChange}
      />
      <RasterOutputPolicyFields
        disabled={disabled}
        options={options}
        onChange={onChange}
      />
    </section>
  );
}

function RasterFormatFields({
  disabled,
  format,
  onChange,
  options,
}: RenderOptionProps<ManualRasterExportOptions> & {
  format: PageImageExportFormat;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <ExportSelectField
        disabled={disabled}
        label={t("exportOptions.outputFormat")}
        value={format}
        options={[
          { value: "source", label: t("exportOptions.formats.source") },
          { value: "png", label: t("exportOptions.formats.png") },
          { value: "jpeg", label: t("exportOptions.formats.jpeg") },
          { value: "webp", label: t("exportOptions.formats.webp") },
        ]}
        onValueChange={(value) =>
          onChange({
            ...options,
            outputFormat: value as PageImageExportFormat,
          })
        }
      />
      {format === "jpeg" || format === "webp" ? (
        <label className="export-number-field">
          <span>{t("exportOptions.quality")}</span>
          <NumberField
            ariaLabel={t("exportOptions.quality")}
            disabled={disabled}
            inputMode="numeric"
            max={100}
            min={1}
            useTextInput
            value={
              format === "jpeg"
                ? (options.jpegQuality ?? 95)
                : (options.webpQuality ?? 90)
            }
            onValueChange={(value) =>
              onChange({
                ...options,
                ...(format === "jpeg"
                  ? { jpegQuality: value }
                  : { webpQuality: value }),
              })
            }
          />
        </label>
      ) : null}
    </>
  );
}

function RasterOutputPolicyFields({
  disabled,
  onChange,
  options,
}: RenderOptionProps<ManualRasterExportOptions>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <ExportSelectField
        disabled={disabled}
        label={t("exportOptions.destination")}
        value={options.destinationMode ?? "timestamped"}
        options={[
          {
            value: "timestamped",
            label: t("exportOptions.destinations.timestamped"),
          },
          { value: "fixed", label: t("exportOptions.destinations.fixed") },
        ]}
        onValueChange={(value) =>
          onChange({
            ...options,
            destinationMode: value as "timestamped" | "fixed",
          })
        }
      />
      <ExportSelectField
        disabled={disabled}
        label={t("exportOptions.collision")}
        value={options.collisionPolicy ?? "replace"}
        options={[
          { value: "replace", label: t("exportOptions.collisions.replace") },
          { value: "skip", label: t("exportOptions.collisions.skip") },
          { value: "cancel", label: t("exportOptions.collisions.cancel") },
        ]}
        onValueChange={(value) =>
          onChange({
            ...options,
            collisionPolicy: value as "replace" | "skip" | "cancel",
          })
        }
      />
      <CheckboxField
        checked={options.preserveSourceNames ?? true}
        disabled={disabled}
        label={t("exportOptions.preserveSourceNames")}
        onCheckedChange={(preserveSourceNames) =>
          onChange({ ...options, preserveSourceNames })
        }
      />
      <CheckboxField
        checked={options.omitText === true}
        disabled={disabled}
        label={t("exportOptions.omitText")}
        onCheckedChange={(omitText) => onChange({ ...options, omitText })}
      />
    </>
  );
}

function ExportSelectField({
  disabled,
  label,
  onValueChange,
  options,
  value,
}: {
  disabled: boolean;
  label: string;
  onValueChange: (value: string) => void;
  options: { value: string; label: string }[];
  value: string;
}): React.JSX.Element {
  return (
    <label className="export-format-field">
      <span>{label}</span>
      <Select
        ariaLabel={label}
        disabled={disabled}
        value={value}
        options={options}
        onValueChange={onValueChange}
      />
    </label>
  );
}

export function ExportOptionsFooter({
  isStarting,
  kind,
  startDisabled,
  onCancel,
  onStart,
}: {
  isStarting: boolean;
  kind: ExportModalKind;
  startDisabled: boolean;
  onCancel: () => void;
  onStart: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
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
            label: isStarting
              ? t("exportOptions.starting")
              : t(
                  kind === "psd"
                    ? "exportOptions.startPsd"
                    : "exportOptions.start",
                ),
            onClick: onStart,
            disabled: isStarting || startDisabled,
          }}
        />
      }
    />
  );
}
