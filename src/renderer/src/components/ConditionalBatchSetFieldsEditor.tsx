import { NumberSetFieldValue } from "./ConditionalBatchNumberValue";
import { useTranslation } from "react-i18next";
import { IconTrash } from "@tabler/icons-react";
import React from "react";
import { getConditionalBatchFieldDefinition } from "../../../shared/conditionalBatchFieldRegistry";
import type {
  ConditionalBatchActionV2,
  ConditionalBatchSetFieldChangeV2,
  ConditionalBatchSetFieldsActionV2,
  ConditionalBatchWritableField,
} from "../../../shared/conditionalBatchRules";
import { ColorField } from "./ColorField";
import styles from "./ConditionalBatchEditor.module.css";
import { ConditionalBatchIdentityField } from "./ConditionalBatchIdentityField";

import { ConditionalBatchSetFieldPicker } from "./ConditionalBatchSetFieldPicker";
import {
  appendConditionalBatchSetFieldDependencies as appendSetFieldDependencies,
  createConditionalBatchSetFieldChange as createSetFieldChange,
  isConditionalBatchSetFieldClearable,
} from "./conditionalBatchSetFieldsModel";
import {
  conditionalBatchEnumOptions,
  isNewConditionalBatchWritableField,
  listConditionalBatchFields,
} from "./conditionalBatchUi";
import { CONDITIONAL_BATCH_FIELD_LABELS } from "./conditionalBatchLabels";
import { Field, TextField } from "./ui/Field";
import { IconButton } from "./ui/IconButton";

import { SegmentedControl } from "./ui/SegmentedControl";
import { Select } from "./ui/Select";

export function ConditionalBatchSetFieldsEditor({
  action,
  onChange,
}: {
  action: ConditionalBatchSetFieldsActionV2;
  onChange: (action: ConditionalBatchActionV2) => void;
}): React.JSX.Element {
  useTranslation();
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
  useTranslation();
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
  const { t } = useTranslation("components");
  const definition = getConditionalBatchFieldDefinition(change.field);
  return (
    <div
      className={styles.setFieldRow}
      data-kind={definition.kind}
      data-operation={change.operation}
    >
      <div className={styles.setFieldHeader}>
        <Field as="div" label={t("batchEditorCopy.propertyToChange")}>
          <Select
            ariaLabel={t("batchEditorCopy.propertyToChange")}
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
          label={t("batchEditorMessages.removeProperty", {
            p0: CONDITIONAL_BATCH_FIELD_LABELS[change.field],
          })}
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
  useTranslation();
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
  const { t } = useTranslation("components");
  const label = CONDITIONAL_BATCH_FIELD_LABELS[change.field];
  const value =
    change.operation === "clear"
      ? "default"
      : change.value === false
        ? "off"
        : "on";
  return (
    <Field as="div" label={t("batchEditorCopy.appliedResult")}>
      <SegmentedControl
        ariaLabel={t("batchEditorMessages.resultFor", {
          p0: label,
        })}
        className={styles.setFieldChoice}
        singleRow
        value={value}
        options={[
          {
            id: "on",
            label: t("batchEditorCopy.on"),
            tooltip: t("batchEditorMessages.enableForAllSelectedBalloons", {
              p0: label,
            }),
          },
          {
            id: "off",
            label: t("batchEditorCopy.off"),
            tooltip: t("batchEditorMessages.disableForAllSelectedBalloons", {
              p0: label,
            }),
          },
          {
            id: "default",
            label: t("settings.api.vertexServiceAccountClear"),
            tooltip: t("batchEditorMessages.clearTheSavedValueAndUseTheApp", {
              p0: label,
            }),
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
  const { t } = useTranslation("components");
  const label = CONDITIONAL_BATCH_FIELD_LABELS[change.field];

  const canClear = isConditionalBatchSetFieldClearable(change.field);
  return (
    <div className={styles.setFieldResult}>
      {canClear ? (
        <Field as="div" label={t("batchEditorCopy.appliedResult")}>
          <SegmentedControl
            ariaLabel={t("batchEditorMessages.resultFor", {
              p0: label,
            })}
            className={styles.setFieldChoice}
            singleRow
            value={change.operation}
            options={[
              {
                id: "set",
                label: t("batchEditorCopy.useNewValue"),
                tooltip: t("batchEditorMessages.setToTheValueBelow", {
                  p0: label,
                }),
              },
              {
                id: "clear",
                label: t("settings.api.vertexServiceAccountClear"),
                tooltip: t(
                  "batchEditorMessages.clearTheSavedValueAndUseTheApp",
                  { p0: label },
                ),
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
          <strong>
            {label} {t("batchEditorCopy.clearValue")}
          </strong>
          <span>
            {t("batchEditorCopy.clearsThisPropertySSavedValueInTheSelected")}
          </span>
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
  const { t } = useTranslation("components");
  const definition = getConditionalBatchFieldDefinition(change.field);
  const label = CONDITIONAL_BATCH_FIELD_LABELS[change.field];
  const textValue = String(change.value ?? "");
  if (change.field === "speakerId") {
    return (
      <ConditionalBatchIdentityField
        field="speakerId"
        label={t("batchEditorCopy.speakerToApply")}
        value={textValue}
        onChange={(value) => onChange({ ...change, value })}
      />
    );
  }
  if (change.field === "fontFamily") {
    return (
      <ConditionalBatchIdentityField
        field="fontFamily"
        label={t("batchEditorCopy.fontToApply")}
        value={textValue}
        onChange={(value) => onChange({ ...change, value })}
      />
    );
  }
  if (definition.kind === "enum") {
    return (
      <Field as="div" label={t("batchEditorCopy.valueToApply")}>
        <Select
          ariaLabel={t("batchEditorMessages.valueFor", {
            p0: label,
          })}
          value={textValue}
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
        label={t("batchEditorMessages.colorFor", {
          p0: label,
        })}
        value={String(change.value ?? "#000000")}
        disabled={false}
        onChange={(value) => onChange({ ...change, value })}
      />
    );
  }
  return (
    <TextField
      label={t("batchEditorCopy.valueToApply")}
      aria-label={t("batchEditorMessages.valueFor", {
        p0: label,
      })}
      value={textValue}
      onChange={(event) => onChange({ ...change, value: event.target.value })}
    />
  );
}
