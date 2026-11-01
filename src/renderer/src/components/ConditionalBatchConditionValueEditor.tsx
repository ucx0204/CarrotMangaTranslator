import { useTranslation } from "react-i18next";
import { type ConditionalBatchConditionV2 } from "../../../shared/conditionalBatchRules";

import { resolveConditionalBatchNumberPresentation } from "./conditionalBatchPresentation";
import {
  conditionalBatchEnumOptions,
  listConditionalBatchFields,
} from "./conditionalBatchUi";

import { ColorField } from "./ColorField";
import { CheckboxField } from "./ui/CheckboxField";
import { Select } from "./ui/Select";

import { Field, Input } from "./ui/Field";

import { NumberField } from "./ui/NumberField";

import { ConditionalPatternBuilder } from "./ConditionalPatternBuilder";

import { ConditionalBatchIdentityField } from "./ConditionalBatchIdentityField";

import styles from "./ConditionalBatchEditor.module.css";

type ConditionValueProps = {
  condition: ConditionalBatchConditionV2;
  sampleText?: string;
  onChange: (condition: ConditionalBatchConditionV2) => void;
};
export function ConditionValueEditor({
  condition,
  sampleText,
  onChange,
}: ConditionValueProps) {
  useTranslation();
  if (
    (condition.operator === "regex" || condition.operator === "notRegex") &&
    condition.matcher
  ) {
    return (
      <ConditionalPatternBuilder
        matcher={condition.matcher}
        sampleText={sampleText}
        onChangeMatcher={(matcher) => onChange({ ...condition, matcher })}
      />
    );
  }
  if (["empty", "notEmpty", "isTrue", "isFalse"].includes(condition.operator)) {
    return null;
  }
  return (
    <IdentityOrScalarConditionValue condition={condition} onChange={onChange} />
  );
}

function IdentityOrScalarConditionValue({
  condition,
  onChange,
}: ConditionValueProps) {
  const { t } = useTranslation("components");
  if (
    condition.field === "speakerId" &&
    ["equals", "notEquals"].includes(condition.operator)
  ) {
    return (
      <ConditionalBatchIdentityField
        field="speakerId"
        label={t("batchEditorCopy.speakerConditionValue")}
        value={String(condition.value ?? "")}
        onChange={(value) => onChange({ ...condition, value })}
      />
    );
  }
  if (condition.field === "fontFamily") {
    return (
      <ConditionalBatchIdentityField
        field="fontFamily"
        label={t("formatBatch.groups.font")}
        ariaLabel={t("batchEditorCopy.fontConditionValue")}
        useDefaultFont
        value={String(condition.value ?? "")}
        onChange={(value) => onChange({ ...condition, value })}
      />
    );
  }
  return <ScalarConditionValue condition={condition} onChange={onChange} />;
}

function ScalarConditionValue({ condition, onChange }: ConditionValueProps) {
  const { t } = useTranslation("components");
  const definition = listConditionalBatchFields().find(
    (field) => field.id === condition.field,
  );
  if (condition.operator === "oneOf" || condition.operator === "notOneOf")
    return <ConditionSetValue condition={condition} onChange={onChange} />;
  if (definition?.kind === "enum")
    return <ConditionEnumValue condition={condition} onChange={onChange} />;
  if (definition?.kind === "number")
    return (
      <ConditionNumberValue
        condition={condition}
        onChange={onChange}
        definition={definition}
      />
    );
  if (definition?.kind === "color")
    return <ConditionColorValue condition={condition} onChange={onChange} />;
  return (
    <Field
      label={t("transform.controlKinds.value")}
      hint={
        condition.field === "speakerId"
          ? t("batchEditorCopy.comparesSavedRuleIdsAsTextToSelectBy")
          : undefined
      }
    >
      <Input
        placeholder={t("batchEditorCopy.valueToCompare")}
        value={String(condition.value ?? "")}
        onChange={(event) =>
          onChange({ ...condition, value: event.target.value })
        }
      />
    </Field>
  );
}

function ConditionEnumValue({ condition, onChange }: ConditionValueProps) {
  const { t } = useTranslation("components");
  const enumOptions = conditionalBatchEnumOptions(condition.field);
  return (
    <Field as="div" label={t("transform.controlKinds.value")}>
      <Select
        ariaLabel={t("batchEditorCopy.conditionValue")}
        value={String(condition.value ?? "")}
        options={enumOptions}
        onValueChange={(value) => onChange({ ...condition, value })}
      />
    </Field>
  );
}

function ConditionSetValue({ condition, onChange }: ConditionValueProps) {
  useTranslation();
  const enumOptions = conditionalBatchEnumOptions(condition.field);
  const selected = new Set(
    Array.isArray(condition.value) ? condition.value : [],
  );
  return (
    <div className={styles.multiValueGrid}>
      {enumOptions.map((option) => (
        <CheckboxField
          key={option.value}
          checked={selected.has(option.value)}
          label={option.label}
          onCheckedChange={(checked) => {
            const next = new Set(selected);
            if (checked) next.add(option.value);
            else next.delete(option.value);
            onChange({
              ...condition,
              value: [...next].length ? [...next] : [option.value],
            });
          }}
        />
      ))}
    </div>
  );
}

function ConditionNumberValue({
  condition,
  onChange,
  definition,
}: ConditionValueProps & {
  definition: ReturnType<typeof listConditionalBatchFields>[number];
}) {
  const { t } = useTranslation("components");
  const number = definition.number;
  const presentation = resolveConditionalBatchNumberPresentation(
    condition.field,
    typeof condition.value === "number"
      ? condition.value
      : (number?.defaultValue ?? 0),
  );
  const end = resolveConditionalBatchNumberPresentation(
    condition.field,
    condition.value2 ??
      (number ? Math.min(number.max, number.defaultValue + number.step) : 1),
  );
  return (
    <div className={styles.valuePair}>
      <Field
        label={
          condition.operator === "between"
            ? t("batchEditorCopy.minimum")
            : t("transform.controlKinds.value")
        }
      >
        <NumberField
          ariaLabel={t("batchEditorCopy.conditionComparisonValue")}
          variant="framed"
          min={presentation.min}
          max={presentation.max}
          step={presentation.step}
          precision={6}
          unit={presentation.unit}
          value={presentation.value}
          onValueChange={(value) =>
            onChange({
              ...condition,
              value: presentation.toStoredValue(value),
            })
          }
        />
      </Field>
      {condition.operator === "between" ? (
        <Field label={t("batchEditorCopy.maximum")}>
          <NumberField
            ariaLabel={t("batchEditorCopy.conditionRangeEnd")}
            variant="framed"
            min={end.min}
            max={end.max}
            step={end.step}
            precision={6}
            unit={end.unit}
            value={end.value}
            onValueChange={(value) =>
              onChange({ ...condition, value2: end.toStoredValue(value) })
            }
          />
        </Field>
      ) : null}
    </div>
  );
}

function ConditionColorValue({ condition, onChange }: ConditionValueProps) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.valuePair}>
      <ColorField
        label={t("batchEditorCopy.color")}
        value={String(condition.value ?? "#000000")}
        disabled={false}
        onChange={(value) => onChange({ ...condition, value })}
      />
      {condition.operator === "near" ? (
        <Field label={t("batchEditorCopy.tolerance")}>
          <Input
            type="number"
            min={0}
            max={100}
            value={condition.tolerance ?? 10}
            onChange={(event) =>
              onChange({
                ...condition,
                tolerance: Number(event.target.value),
              })
            }
          />
        </Field>
      ) : null}
    </div>
  );
}
