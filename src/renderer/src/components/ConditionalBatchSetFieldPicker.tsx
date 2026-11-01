import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";
import React from "react";
import type {
  ConditionalBatchActionV2,
  ConditionalBatchSetFieldsActionV2,
  ConditionalBatchWritableField,
} from "../../../shared/conditionalBatchRules";
import styles from "./ConditionalBatchEditor.module.css";
import {
  appendConditionalBatchSetFieldDependencies,
  createConditionalBatchSetFieldChange,
} from "./conditionalBatchSetFieldsModel";
import { listConditionalBatchFields } from "./conditionalBatchUi";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import { Select } from "./ui/Select";

export function ConditionalBatchSetFieldPicker({
  action,
  unused,
  onChange,
}: {
  action: ConditionalBatchSetFieldsActionV2;
  unused: ReturnType<typeof listConditionalBatchFields>;
  onChange: (action: ConditionalBatchActionV2) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  const [fieldToAdd, setFieldToAdd] =
    React.useState<ConditionalBatchWritableField>(
      (unused[0]?.id as ConditionalBatchWritableField) ?? "translatedText",
    );
  React.useEffect(() => {
    if (!unused.some((field) => field.id === fieldToAdd)) {
      setFieldToAdd(
        (unused[0]?.id as ConditionalBatchWritableField | undefined) ??
          "translatedText",
      );
    }
  }, [fieldToAdd, unused]);
  if (unused.length === 0) return null;
  const canAdd = unused.some((field) => field.id === fieldToAdd);
  return (
    <div className={styles.fieldPickerAll}>
      <Field as="div" label={t("batchEditorCopy.addProperty")}>
        <Select
          ariaLabel={t("batchEditorCopy.propertyToAdd")}
          searchable
          value={fieldToAdd}
          options={unused.map((field) => ({
            value: field.id,
            label: field.label,
            group: field.categoryLabel,
            searchText: `${field.label} ${field.id} ${field.categoryLabel}`,
          }))}
          onValueChange={(field) =>
            setFieldToAdd(field as ConditionalBatchWritableField)
          }
        />
      </Field>
      <Button
        size="sm"
        iconLeft={<IconPlus size={14} />}
        disabled={!canAdd}
        onClick={() => {
          if (!canAdd) return;
          const changes = [
            ...action.changes,
            createConditionalBatchSetFieldChange(fieldToAdd),
          ];
          onChange({
            ...action,
            changes: appendConditionalBatchSetFieldDependencies(
              changes,
              fieldToAdd,
            ),
          });
        }}
      >
        {t("common.add")}
      </Button>
    </div>
  );
}
