import { IconPlus } from "@tabler/icons-react";
import React from "react";
import type {
  ConditionalBatchActionV2,
  ConditionalBatchSetFieldsActionV2,
  ConditionalBatchWritableField,
} from "../../../shared/conditionalBatchRules";
import { listConditionalBatchFields } from "./conditionalBatchUi";
import {
  appendConditionalBatchSetFieldDependencies,
  createConditionalBatchSetFieldChange,
} from "./conditionalBatchSetFieldsModel";
import { Button, Select } from "./ConditionalBatchControls";
import { Field } from "./ui/Field";
import styles from "./ConditionalBatchEditor.module.css";

export function ConditionalBatchSetFieldPicker({
  action,
  unused,
  onChange,
}: {
  action: ConditionalBatchSetFieldsActionV2;
  unused: ReturnType<typeof listConditionalBatchFields>;
  onChange: (action: ConditionalBatchActionV2) => void;
}): React.JSX.Element | null {
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
      <Field as="div" label="속성 추가">
        <Select
          ariaLabel="추가할 속성"
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
        추가
      </Button>
    </div>
  );
}
