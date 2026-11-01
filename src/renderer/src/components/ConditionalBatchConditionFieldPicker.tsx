import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";

import React from "react";

import type { ConditionalBatchField } from "../../../shared/conditionalBatchFieldRegistry";

import {
  QUICK_CONDITIONAL_BATCH_FIELDS,
  isNewConditionalBatchConditionField,
  listConditionalBatchFields,
} from "./conditionalBatchUi";
import { CONDITIONAL_BATCH_FIELD_LABELS } from "./conditionalBatchLabels";

import { Button } from "./ui/Button";
import { Select } from "./ui/Select";

import styles from "./ConditionalBatchEditor.module.css";

export function FieldPicker({
  disabled,
  recentFields,
  onAdd,
}: {
  disabled: boolean;
  recentFields: readonly ConditionalBatchField[];
  onAdd: (field: ConditionalBatchField) => void;
}) {
  const { t } = useTranslation("components");
  const [selected, setSelected] =
    React.useState<ConditionalBatchField>("translatedText");
  const quickFields = [...recentFields, ...QUICK_CONDITIONAL_BATCH_FIELDS]
    .filter((field, index, all) => all.indexOf(field) === index)
    .slice(0, 5);
  return (
    <details className={styles.addMenu}>
      <summary>
        <IconPlus size={15} />
        {t("batchEditorCopy.addCondition")}
      </summary>
      <div className={styles.fieldPicker}>
        <div className={styles.quickFields}>
          {quickFields.map((field) => (
            <Button
              key={field}
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onAdd(field)}
            >
              {CONDITIONAL_BATCH_FIELD_LABELS[field]}
            </Button>
          ))}
        </div>
        <div className={styles.fieldPickerAll}>
          <Select
            ariaLabel={t("batchEditorCopy.conditionFieldToAdd")}
            searchable
            searchPlaceholder={t("batchEditorCopy.searchConditionFields")}
            disabled={disabled}
            value={selected}
            options={listConditionalBatchFields()
              .filter((field) => isNewConditionalBatchConditionField(field.id))
              .map((field) => ({
                value: field.id,
                label: field.label,
                group: field.categoryLabel,
                searchText: `${field.label} ${field.id} ${field.categoryLabel}`,
              }))}
            onValueChange={(value) =>
              setSelected(value as ConditionalBatchField)
            }
          />
          <Button size="sm" disabled={disabled} onClick={() => onAdd(selected)}>
            {t("common.add")}
          </Button>
        </div>
      </div>
    </details>
  );
}
