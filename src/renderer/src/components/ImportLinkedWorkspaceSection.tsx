import React from "react";
import { useTranslation } from "react-i18next";
import type {
  LinkedWorkspaceImportOptions,
  RasterExportFormat,
} from "../../../shared/linkedWorkspaceTypes";
import { CheckboxField } from "./ui/CheckboxField";
import { NumberField } from "./ui/NumberField";
import { Select } from "./ui/Select";

export function ImportLinkedWorkspaceSection({
  busy,
  onChange,
  options,
}: {
  busy: boolean;
  onChange: React.Dispatch<React.SetStateAction<LinkedWorkspaceImportOptions>>;
  options: LinkedWorkspaceImportOptions;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const quality =
    options.outputFormat === "jpeg" ? options.jpegQuality : options.webpQuality;
  return (
    <section className="modal-section import-linked-workspace-section">
      <CheckboxField
        variant="switch"
        checked={options.enabled}
        disabled={busy}
        label={t("import.liveResults.enable")}
        onCheckedChange={(enabled) =>
          onChange((current) => ({ ...current, enabled }))
        }
      />
      <p>{t("import.liveResults.description")}</p>
      {options.enabled ? (
        <div className="import-linked-workspace-fields">
          <label>
            <span>{t("import.liveResults.format")}</span>
            <Select
              ariaLabel={t("import.liveResults.format")}
              disabled={busy}
              value={options.outputFormat}
              options={[
                { value: "source", label: t("exportOptions.formats.source") },
                { value: "png", label: t("exportOptions.formats.png") },
                { value: "jpeg", label: t("exportOptions.formats.jpeg") },
                { value: "webp", label: t("exportOptions.formats.webp") },
              ]}
              onValueChange={(value) =>
                onChange((current) => ({
                  ...current,
                  outputFormat: value as RasterExportFormat,
                }))
              }
            />
          </label>
          {options.outputFormat === "jpeg" ||
          options.outputFormat === "webp" ? (
            <label>
              <span>{t("exportOptions.quality")}</span>
              <NumberField
                ariaLabel={t("exportOptions.quality")}
                disabled={busy}
                inputMode="numeric"
                max={100}
                min={1}
                useTextInput
                value={quality}
                onValueChange={(value) =>
                  onChange((current) => ({
                    ...current,
                    ...(current.outputFormat === "jpeg"
                      ? { jpegQuality: value }
                      : { webpQuality: value }),
                  }))
                }
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
