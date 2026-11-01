import {
  TEXT_STYLE_FIELD_LABELS,
  createTextStyleMatchCondition,
  textStyleOperatorOptions,
  isTextStyleBooleanField,
  isTextStyleColorField,
  textStyleNumberField,
} from "./conditionalBatchStyleMatchPresentation";
import { useTranslation } from "react-i18next";
import { IconPlus, IconTrash } from "@tabler/icons-react";

import { DEFAULT_BLOCK_FONT_ID } from "../../../shared/blockFontCatalog";

import {
  CONDITIONAL_BATCH_TEXT_STYLE_FIELDS,
  type ConditionalBatchActionV2,
  type ConditionalBatchStyleTextActionV2,
  type ConditionalBatchTextStyleField,
  type ConditionalBatchTextStyleMatchCondition,
  type ConditionalBatchTextStyleOperator,
} from "../../../shared/conditionalBatchRules";

import { resolveConditionalBatchNumberPresentation } from "./conditionalBatchPresentation";

import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { Select } from "./ui/Select";

import { FontSelect } from "./FontSelect";

import { ColorField } from "./ColorField";

import { IconButton } from "./ui/IconButton";

import { NumberField } from "./ui/NumberField";

import { SegmentedControl } from "./ui/SegmentedControl";

import styles from "./ConditionalBatchEditor.module.css";

export function ExistingStyleMatchEditor({
  action,
  onChange,
}: {
  action: ConditionalBatchStyleTextActionV2;
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  const { t } = useTranslation("components");
  const matchStyle = action.matchStyle;
  const usedFields = new Set(
    matchStyle?.conditions.map((condition) => condition.field) ?? [],
  );
  const availableFields = CONDITIONAL_BATCH_TEXT_STYLE_FIELDS.filter(
    (field) => !usedFields.has(field),
  );
  const updateMatch = (
    conditions: ConditionalBatchTextStyleMatchCondition[],
  ): void => {
    onChange({
      ...action,
      matchStyle: {
        logic: matchStyle?.logic ?? "all",
        conditions,
      },
    });
  };
  return (
    <div className={styles.existingStyleMatch}>
      <StyleMatchActivationControls
        action={action}
        matchStyle={matchStyle}
        onChange={onChange}
      />
      {matchStyle ? (
        <div className={styles.existingStyleConditions}>
          {matchStyle.conditions.map((condition, index) => (
            <TextStyleMatchConditionEditor
              key={condition.id}
              condition={condition}
              disabledFields={usedFields}
              onChange={(next) =>
                updateMatch(
                  matchStyle.conditions.map((entry, entryIndex) =>
                    entryIndex === index ? next : entry,
                  ),
                )
              }
              onDelete={() =>
                matchStyle.conditions.length === 1
                  ? onChange({ ...action, matchStyle: undefined })
                  : updateMatch(
                      matchStyle.conditions.filter(
                        (_entry, entryIndex) => entryIndex !== index,
                      ),
                    )
              }
            />
          ))}
          {availableFields.length ? (
            <Button
              size="sm"
              variant="ghost"
              iconLeft={<IconPlus size={14} />}
              onClick={() =>
                updateMatch([
                  ...matchStyle.conditions,
                  createTextStyleMatchCondition(availableFields[0] ?? "bold"),
                ])
              }
            >
              {t("batchEditorCopy.addFormattingCondition")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TextStyleMatchConditionEditor({
  condition,
  disabledFields,
  onChange,
  onDelete,
}: {
  condition: ConditionalBatchTextStyleMatchCondition;
  disabledFields: ReadonlySet<ConditionalBatchTextStyleField>;
  onChange: (condition: ConditionalBatchTextStyleMatchCondition) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("components");
  const operators = textStyleOperatorOptions(condition.field);
  return (
    <div className={styles.existingStyleConditionRow}>
      <Select
        ariaLabel={t("batchEditorCopy.existingInlineFormatting")}
        value={condition.field}
        options={CONDITIONAL_BATCH_TEXT_STYLE_FIELDS.map((field) => ({
          value: field,
          label: TEXT_STYLE_FIELD_LABELS[field],
          disabled: field !== condition.field && disabledFields.has(field),
        }))}
        onValueChange={(field) =>
          onChange(
            createTextStyleMatchCondition(
              field as ConditionalBatchTextStyleField,
              condition.id,
            ),
          )
        }
      />
      <Select
        ariaLabel={t("batchEditorCopy.inlineFormatComparison")}
        value={condition.operator}
        options={operators}
        onValueChange={(operator) =>
          onChange({
            ...condition,
            operator: operator as ConditionalBatchTextStyleOperator,
            ...(operator === "between"
              ? { value2: Number(condition.value) }
              : { value2: undefined }),
          })
        }
      />
      <TextStyleMatchValueEditor condition={condition} onChange={onChange} />
      <IconButton
        label={t("batchEditorCopy.deleteFormattingCondition")}
        onClick={onDelete}
      >
        <IconTrash size={15} />
      </IconButton>
    </div>
  );
}

function TextStyleMatchValueEditor({
  condition,
  onChange,
}: {
  condition: ConditionalBatchTextStyleMatchCondition;
  onChange: (condition: ConditionalBatchTextStyleMatchCondition) => void;
}) {
  const { t } = useTranslation("components");
  if (isTextStyleBooleanField(condition.field)) {
    return (
      <Select
        ariaLabel={t("batchEditorCopy.inlineFormatValue")}
        value={condition.value === true ? "true" : "false"}
        options={[
          {
            value: "true",
            label: t("gatherText.toggleOn"),
          },
          {
            value: "false",
            label: t("gatherText.toggleOff"),
          },
        ]}
        onValueChange={(value) =>
          onChange({ ...condition, value: value === "true" })
        }
      />
    );
  }
  if (condition.field === "fontFamily") {
    return (
      <FontSelect
        ariaLabel={t("batchEditorCopy.inlineFontToCompare")}
        preserveFontId
        value={String(condition.value) || undefined}
        onChange={(fontFamily) =>
          onChange({ ...condition, value: fontFamily ?? DEFAULT_BLOCK_FONT_ID })
        }
      />
    );
  }
  if (isTextStyleColorField(condition.field)) {
    return (
      <ColorField
        label={t("batchEditorCopy.inlineFormatColor")}
        value={String(condition.value) || "#000000"}
        disabled={false}
        onChange={(value) => onChange({ ...condition, value })}
      />
    );
  }
  return (
    <TextStyleMatchNumberValue condition={condition} onChange={onChange} />
  );
}

function StyleMatchActivationControls({
  action,
  matchStyle,
  onChange,
}: {
  action: ConditionalBatchStyleTextActionV2;
  matchStyle: ConditionalBatchStyleTextActionV2["matchStyle"];
  onChange: (action: ConditionalBatchActionV2) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.existingStyleMatchHeader}>
      <CheckboxField
        checked={Boolean(matchStyle)}
        label={t("batchEditorCopy.narrowByExistingFormatting")}
        onCheckedChange={(checked) =>
          onChange({
            ...action,
            matchStyle: checked
              ? {
                  logic: "all",
                  conditions: [createTextStyleMatchCondition("bold")],
                }
              : undefined,
          })
        }
      />
      {matchStyle && matchStyle.conditions.length > 1 ? (
        <SegmentedControl
          ariaLabel={t("batchEditorCopy.combineFormattingConditions")}
          singleRow
          value={matchStyle.logic}
          options={[
            {
              id: "all",
              label: t("batchEditorCopy.all"),
            },
            {
              id: "any",
              label: t("batchEditorCopy.any"),
            },
          ]}
          onChange={(logic) =>
            onChange({
              ...action,
              matchStyle: { ...matchStyle, logic },
            })
          }
        />
      ) : null}
    </div>
  );
}

function TextStyleMatchNumberValue({
  condition,
  onChange,
}: {
  condition: ConditionalBatchTextStyleMatchCondition;
  onChange: (condition: ConditionalBatchTextStyleMatchCondition) => void;
}) {
  const { t } = useTranslation("components");
  const field = textStyleNumberField(condition.field);
  const presentation = resolveConditionalBatchNumberPresentation(
    field,
    Number(condition.value),
  );
  const end = resolveConditionalBatchNumberPresentation(
    field,
    condition.value2 ?? Number(condition.value),
  );
  return (
    <div className={styles.existingStyleNumberValue}>
      <NumberField
        ariaLabel={t("batchEditorCopy.formattingComparisonValue")}
        variant="framed"
        min={presentation.min}
        max={presentation.max}
        step={presentation.step}
        precision={6}
        unit={presentation.unit}
        value={presentation.value}
        onValueChange={(value) =>
          onChange({ ...condition, value: presentation.toStoredValue(value) })
        }
      />
      {condition.operator === "between" ? (
        <>
          <span>~</span>
          <NumberField
            ariaLabel={t("batchEditorCopy.formattingRangeEnd")}
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
        </>
      ) : null}
    </div>
  );
}
