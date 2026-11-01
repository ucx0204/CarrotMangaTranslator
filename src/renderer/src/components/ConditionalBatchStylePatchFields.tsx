import { useTranslation } from "react-i18next";
import { type ConditionalBatchWritableField } from "../../../shared/conditionalBatchRules";

import { resolveConditionalBatchNumberPresentation } from "./conditionalBatchPresentation";

import { CheckboxField } from "./ui/CheckboxField";

import { FontSelect } from "./FontSelect";

import { ColorField } from "./ColorField";

import { NumberField } from "./ui/NumberField";

import { SegmentedControl } from "./ui/SegmentedControl";

import styles from "./ConditionalBatchEditor.module.css";

export function PatchFontValue({
  value,
  onChange,
}: {
  value: string | null | undefined;
  onChange: (value: string | null | undefined) => void;
}) {
  const { t } = useTranslation("components");
  const enabled = value !== undefined;
  return (
    <div className={styles.patchField}>
      <CheckboxField
        checked={enabled}
        label={t("formatBatch.groups.font")}
        onCheckedChange={(checked) => onChange(checked ? "" : undefined)}
      />
      {enabled ? (
        <div className={styles.patchValue}>
          <FontSelect
            ariaLabel={t("batchEditorCopy.inlineFont")}
            disabled={value === null}
            value={typeof value === "string" ? value || undefined : undefined}
            onChange={(fontFamily) => onChange(fontFamily ?? "")}
          />
          <CheckboxField
            checked={value === null}
            label={t("common.reset")}
            onCheckedChange={(checked) => onChange(checked ? null : "")}
          />
        </div>
      ) : null}
    </div>
  );
}

export function PatchColorValue({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string | null | undefined) => void;
  value: string | null | undefined;
}) {
  const { t } = useTranslation("components");
  const enabled = value !== undefined;
  return (
    <div className={styles.patchField}>
      <CheckboxField
        checked={enabled}
        label={label}
        onCheckedChange={(checked) => onChange(checked ? "#000000" : undefined)}
      />
      {enabled ? (
        <div className={styles.patchValue}>
          <ColorField
            label={label}
            labelHidden
            disabled={value === null}
            value={typeof value === "string" ? value : "#000000"}
            onChange={onChange}
          />
          <CheckboxField
            checked={value === null}
            label={t("common.reset")}
            onCheckedChange={(checked) => onChange(checked ? null : "#000000")}
          />
        </div>
      ) : null}
    </div>
  );
}

export function PatchBoolean({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null | undefined;
  onChange: (value: boolean | null | undefined) => void;
}) {
  const { t } = useTranslation("components");
  const enabled = value !== undefined;
  return (
    <div className={styles.patchField}>
      <CheckboxField
        checked={enabled}
        label={label}
        onCheckedChange={(checked) => onChange(checked ? true : undefined)}
      />
      {enabled ? (
        <SegmentedControl
          ariaLabel={t("batchEditorMessages.value", {
            p0: label,
          })}
          singleRow
          value={value === true ? "on" : value === false ? "off" : "clear"}
          options={[
            {
              id: "on",
              label: t("batchEditorCopy.on"),
            },
            {
              id: "off",
              label: t("batchEditorCopy.off"),
            },
            {
              id: "clear",
              label: t("common.reset"),
            },
          ]}
          onChange={(next) =>
            onChange(next === "on" ? true : next === "off" ? false : null)
          }
        />
      ) : null}
    </div>
  );
}

export function PatchValue({
  label,
  value,
  field,
  onChange,
}: {
  label: string;
  value: number | null | undefined;
  field: ConditionalBatchWritableField;
  onChange: (value: number | null | undefined) => void;
}) {
  const { t } = useTranslation("components");
  const enabled = value !== undefined;
  const presentation = resolveConditionalBatchNumberPresentation(
    field,
    value ?? 1,
  );
  return (
    <div className={styles.patchField}>
      <CheckboxField
        checked={enabled}
        label={label}
        onCheckedChange={(checked) => onChange(checked ? 1 : undefined)}
      />
      {enabled ? (
        <div className={styles.patchValue}>
          <NumberField
            ariaLabel={t("batchEditorMessages.partialFormattingValueFor", {
              p0: label,
            })}
            variant="framed"
            min={presentation.min}
            max={presentation.max}
            step={presentation.step}
            precision={6}
            unit={presentation.unit}
            disabled={value === null}
            value={presentation.value}
            onValueChange={(next) => onChange(presentation.toStoredValue(next))}
          />
          <CheckboxField
            checked={value === null}
            label={t("common.reset")}
            onCheckedChange={(checked) => onChange(checked ? null : 1)}
          />
        </div>
      ) : null}
    </div>
  );
}
