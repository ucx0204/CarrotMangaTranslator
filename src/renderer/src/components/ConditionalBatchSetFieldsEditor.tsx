import { IconTrash } from "@tabler/icons-react";
import React from "react";
import { getConditionalBatchFieldDefinition } from "../../../shared/conditionalBatchFieldRegistry";
import type {
  ConditionalBatchActionV2,
  ConditionalBatchSetFieldChangeV2,
  ConditionalBatchSetFieldsActionV2,
  ConditionalBatchWritableField,
} from "../../../shared/conditionalBatchRules";
import {
  CONDITIONAL_BATCH_FIELD_LABELS,
  conditionalBatchEnumOptions,
  isNewConditionalBatchWritableField,
  listConditionalBatchFields,
} from "./conditionalBatchUi";
import {
  appendConditionalBatchSetFieldDependencies as appendSetFieldDependencies,
  createConditionalBatchSetFieldChange as createSetFieldChange,
  isConditionalBatchSetFieldClearable,
  resolveConditionalBatchNumberPresentation,
} from "./conditionalBatchSetFieldsModel";
import { ConditionalBatchSetFieldPicker } from "./ConditionalBatchSetFieldPicker";
import { ColorField } from "./ColorField";
import { Select } from "./ConditionalBatchControls";
import { FontSelect } from "./FontSelect";
import { Field, TextField } from "./ui/Field";
import { IconButton } from "./ui/IconButton";
import { NumberField } from "./ui/NumberField";
import { SegmentedControl } from "./ui/SegmentedControl";
import styles from "./ConditionalBatchEditor.module.css";

export function ConditionalBatchSetFieldsEditor({
  action,
  onChange,
}: {
  action: ConditionalBatchSetFieldsActionV2;
  onChange: (action: ConditionalBatchActionV2) => void;
}): React.JSX.Element {
  const existingFields = new Set(action.changes.map((change) => change.field));
  const writableFields = listConditionalBatchFields().filter(
    (field) =>
      field.writable &&
      (existingFields.has(field.id as ConditionalBatchWritableField) ||
        isNewConditionalBatchWritableField(field.id)),
  );
  const unused = writableFields.filter(
    (field) => !action.changes.some((change) => change.field === field.id),
  );
  return (
    <div className={styles.setFieldsEditor}>
      <p className={styles.setFieldIntro}>
        각 속성을 선택한 결과로 바꿉니다. 필요한 관련 속성은 자동으로 함께
        추가됩니다.
      </p>
      <SetFieldRows
        action={action}
        writableFields={writableFields}
        onChange={onChange}
      />
      <ConditionalBatchSetFieldPicker
        action={action}
        unused={unused}
        onChange={onChange}
      />
    </div>
  );
}

function SetFieldRows({
  action,
  writableFields,
  onChange,
}: {
  action: ConditionalBatchSetFieldsActionV2;
  writableFields: ReturnType<typeof listConditionalBatchFields>;
  onChange: (action: ConditionalBatchActionV2) => void;
}): React.JSX.Element {
  const updateChange = (
    index: number,
    change: ConditionalBatchSetFieldChangeV2,
  ): void =>
    onChange({
      ...action,
      changes: action.changes.map((entry, entryIndex) =>
        entryIndex === index ? change : entry,
      ),
    });
  return (
    <div className={styles.setFieldList}>
      {action.changes.map((change, index) => (
        <SetFieldRow
          key={change.field}
          action={action}
          change={change}
          writableFields={writableFields}
          onChange={(next) => updateChange(index, next)}
          onFieldChange={(nextField) => {
            const changes = action.changes.map((entry, entryIndex) =>
              entryIndex === index ? createSetFieldChange(nextField) : entry,
            );
            onChange({
              ...action,
              changes: appendSetFieldDependencies(changes, nextField),
            });
          }}
          onRemove={() =>
            onChange({
              ...action,
              changes: action.changes.filter(
                (_entry, entryIndex) => entryIndex !== index,
              ),
            })
          }
        />
      ))}
    </div>
  );
}

function SetFieldRow({
  action,
  change,
  writableFields,
  onChange,
  onFieldChange,
  onRemove,
}: {
  action: ConditionalBatchSetFieldsActionV2;
  change: ConditionalBatchSetFieldChangeV2;
  writableFields: ReturnType<typeof listConditionalBatchFields>;
  onChange: (change: ConditionalBatchSetFieldChangeV2) => void;
  onFieldChange: (field: ConditionalBatchWritableField) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const definition = getConditionalBatchFieldDefinition(change.field);
  return (
    <div
      className={styles.setFieldRow}
      data-kind={definition.kind}
      data-operation={change.operation}
    >
      <div className={styles.setFieldHeader}>
        <Field as="div" label="바꿀 속성">
          <Select
            ariaLabel="바꿀 속성"
            searchable
            value={change.field}
            options={writableFields.map((field) => ({
              value: field.id,
              label: field.label,
              group: field.categoryLabel,
              searchText: `${field.label} ${field.id} ${field.categoryLabel}`,
              disabled: action.changes.some(
                (entry) =>
                  entry.field === field.id && entry.field !== change.field,
              ),
            }))}
            onValueChange={(field) =>
              onFieldChange(field as ConditionalBatchWritableField)
            }
          />
        </Field>
        <IconButton
          className={styles.setFieldRemove}
          size="sm"
          variant="danger"
          label={`${CONDITIONAL_BATCH_FIELD_LABELS[change.field]} 속성 삭제`}
          disabled={action.changes.length <= 1}
          onClick={onRemove}
        >
          <IconTrash size={14} />
        </IconButton>
      </div>
      <SetFieldResultEditor change={change} onChange={onChange} />
    </div>
  );
}

function SetFieldResultEditor({
  change,
  onChange,
}: {
  change: ConditionalBatchSetFieldChangeV2;
  onChange: (change: ConditionalBatchSetFieldChangeV2) => void;
}): React.JSX.Element {
  const definition = getConditionalBatchFieldDefinition(change.field);
  if (definition.kind === "boolean") {
    return <BooleanSetFieldResult change={change} onChange={onChange} />;
  }
  return <ValueSetFieldResult change={change} onChange={onChange} />;
}

function BooleanSetFieldResult({
  change,
  onChange,
}: {
  change: ConditionalBatchSetFieldChangeV2;
  onChange: (change: ConditionalBatchSetFieldChangeV2) => void;
}): React.JSX.Element {
  const label = CONDITIONAL_BATCH_FIELD_LABELS[change.field];
  const value =
    change.operation === "clear"
      ? "default"
      : change.value === false
        ? "off"
        : "on";
  return (
    <Field as="div" label="적용 결과">
      <SegmentedControl
        ariaLabel={`${label} 적용 결과`}
        className={styles.setFieldChoice}
        singleRow
        value={value}
        options={[
          {
            id: "on",
            label: "켜기",
            tooltip: `선택한 모든 말풍선에서 ${label} 속성을 켭니다.`,
          },
          {
            id: "off",
            label: "끄기",
            tooltip: `선택한 모든 말풍선에서 ${label} 속성을 끕니다.`,
          },
          {
            id: "default",
            label: "해제",
            tooltip: `${label} 저장값을 지우고 앱의 기본 동작을 사용합니다.`,
          },
        ]}
        onChange={(next) =>
          onChange(
            next === "default"
              ? { field: change.field, operation: "clear" }
              : {
                  field: change.field,
                  operation: "set",
                  value: next === "on",
                },
          )
        }
      />
    </Field>
  );
}

function ValueSetFieldResult({
  change,
  onChange,
}: {
  change: ConditionalBatchSetFieldChangeV2;
  onChange: (change: ConditionalBatchSetFieldChangeV2) => void;
}): React.JSX.Element {
  const label = CONDITIONAL_BATCH_FIELD_LABELS[change.field];

  const canClear = isConditionalBatchSetFieldClearable(change.field);
  return (
    <div className={styles.setFieldResult}>
      {canClear ? (
        <Field as="div" label="적용 결과">
          <SegmentedControl
            ariaLabel={`${label} 적용 결과`}
            className={styles.setFieldChoice}
            singleRow
            value={change.operation}
            options={[
              {
                id: "set",
                label: "새 값 사용",
                tooltip: `${label}을(를) 아래 값으로 바꿉니다.`,
              },
              {
                id: "clear",
                label: "해제",
                tooltip: `${label} 저장값을 지우고 앱의 기본 동작을 사용합니다.`,
              },
            ]}
            onChange={(operation) =>
              onChange(
                operation === "clear"
                  ? { field: change.field, operation }
                  : createSetFieldChange(change.field),
              )
            }
          />
        </Field>
      ) : null}
      {change.operation === "set" ? (
        <SetFieldValueEditor change={change} onChange={onChange} />
      ) : (
        <div className={styles.setFieldDefaultNote}>
          <strong>{label} 지정 해제</strong>
          <span>선택한 말풍선에서 이 속성의 저장값을 지웁니다.</span>
        </div>
      )}
    </div>
  );
}

function SetFieldValueEditor({
  change,
  onChange,
}: {
  change: ConditionalBatchSetFieldChangeV2;
  onChange: (change: ConditionalBatchSetFieldChangeV2) => void;
}): React.JSX.Element {
  const definition = getConditionalBatchFieldDefinition(change.field);
  const label = CONDITIONAL_BATCH_FIELD_LABELS[change.field];
  if (change.field === "fontFamily") {
    return (
      <Field as="div" label="적용할 글꼴">
        <FontSelect
          ariaLabel="적용할 글꼴"
          value={String(change.value ?? "") || undefined}
          onChange={(fontFamily) =>
            onChange({ ...change, value: fontFamily ?? "" })
          }
        />
      </Field>
    );
  }
  if (definition.kind === "enum") {
    return (
      <Field as="div" label="적용할 값">
        <Select
          ariaLabel={`${label} 적용할 값`}
          value={String(change.value ?? "")}
          options={conditionalBatchEnumOptions(change.field)}
          onValueChange={(value) => onChange({ ...change, value })}
        />
      </Field>
    );
  }
  if (definition.kind === "number" && definition.number) {
    return <NumberSetFieldValue change={change} onChange={onChange} />;
  }
  if (definition.kind === "color") {
    return (
      <ColorField
        label={`${label} 적용할 색상`}
        value={String(change.value ?? "#000000")}
        disabled={false}
        onChange={(value) => onChange({ ...change, value })}
      />
    );
  }
  return (
    <TextField
      label="적용할 값"
      aria-label={`${label} 적용할 값`}
      value={String(change.value ?? "")}
      onChange={(event) => onChange({ ...change, value: event.target.value })}
    />
  );
}

function NumberSetFieldValue({
  change,
  onChange,
}: {
  change: ConditionalBatchSetFieldChangeV2;
  onChange: (change: ConditionalBatchSetFieldChangeV2) => void;
}): React.JSX.Element {
  const definition = getConditionalBatchFieldDefinition(change.field);
  const fallback = definition.number?.defaultValue ?? 0;
  const presentation = resolveConditionalBatchNumberPresentation(
    change.field,
    typeof change.value === "number" ? change.value : fallback,
  );
  const label = CONDITIONAL_BATCH_FIELD_LABELS[change.field];
  return (
    <Field
      label="적용할 값"
      hint={`입력 범위 ${presentation.min}${presentation.unit}–${presentation.max}${presentation.unit}`}
    >
      <NumberField
        ariaLabel={`${label} 적용할 값`}
        variant="framed"
        min={presentation.min}
        max={presentation.max}
        step={presentation.step}
        unit={presentation.unit}
        value={presentation.value}
        onValueChange={(value) =>
          onChange({ ...change, value: presentation.toStoredValue(value) })
        }
      />
    </Field>
  );
}
