import { useTranslation } from "react-i18next";
import {
  IconArrowDown,
  IconArrowUp,
  IconCopy,
  IconTrash,
} from "@tabler/icons-react";

import React from "react";

import type {
  ConditionalBatchField,
  ConditionalBatchOperator,
} from "../../../shared/conditionalBatchFieldRegistry";

import {
  type ConditionalBatchConditionV2,
  type ConditionalBatchPreviewResult,
} from "../../../shared/conditionalBatchRules";

import {
  conditionValueForOperator,
  createConditionForField,
} from "./conditionalBatchDraftDefaults";
import {
  formatConditionalBatchDisplayValue,
  summarizeCondition,
} from "./conditionalBatchPresentation";
import {
  isNewConditionalBatchConditionField,
  listConditionalBatchFields,
} from "./conditionalBatchUi";
import {
  CONDITIONAL_BATCH_FIELD_LABELS,
  CONDITIONAL_BATCH_OPERATOR_LABELS,
} from "./conditionalBatchLabels";

import { CheckboxField } from "./ui/CheckboxField";
import { Select } from "./ui/Select";

import { useFonts } from "../fonts/useFonts";

import { Field, TextField } from "./ui/Field";

import { IconButton } from "./ui/IconButton";

import { ConditionalBatchSpeakersContext } from "./conditionalBatchSpeakers";

import styles from "./ConditionalBatchEditor.module.css";

import { Button as UiButton } from "./ui/Button";

import { conditionOperators } from "./conditionalBatchConditionModel";

import { ConditionValueEditor } from "./ConditionalBatchConditionValueEditor";

type ConditionCardProps = {
  condition: ConditionalBatchConditionV2;
  currentResult: ConditionalBatchPreviewResult | null;
  expanded: boolean;
  index: number;
  total: number;
  onChange: (condition: ConditionalBatchConditionV2) => void;
  onDuplicate: () => void;
  onExpand: () => void;
  onMove: (offset: -1 | 1) => void;
  onRemove: () => void;
  canDuplicate?: boolean;
  canRemove?: boolean;
};

export function ConditionCard({
  condition,
  currentResult,
  expanded,
  index,
  total,
  onChange,
  onDuplicate,
  onExpand,
  onMove,
  onRemove,
  canDuplicate = true,
  canRemove = true,
}: ConditionCardProps) {
  const { t } = useTranslation("components");
  const evaluation = currentResult?.conditionEvaluations.find(
    (entry) => entry.conditionId === condition.id,
  );

  return (
    <article
      className={styles.sentenceCard}
      data-enabled={condition.enabled}
      data-expanded={expanded}
    >
      <div className={styles.sentenceHeader}>
        <CheckboxField
          checked={condition.enabled}
          ariaLabel={t("batchEditorMessages.enableCondition", {
            p0: index + 1,
          })}
          onCheckedChange={(enabled) => onChange({ ...condition, enabled })}
        />
        <ConditionSummary
          condition={condition}
          expanded={expanded}
          onExpand={onExpand}
          evaluation={evaluation}
        />
        <ConditionOrderingButtons
          total={total}
          index={index}
          onMove={onMove}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
          canDuplicate={canDuplicate}
          canRemove={canRemove}
        />
      </div>
      {expanded ? (
        <ConditionEditor
          condition={condition}
          sampleText={evaluation?.actualValue}
          onChange={onChange}
        />
      ) : null}
    </article>
  );
}

function ConditionEditor({
  condition,
  sampleText,
  onChange,
}: {
  condition: ConditionalBatchConditionV2;
  sampleText?: string;
  onChange: (condition: ConditionalBatchConditionV2) => void;
}) {
  const { t } = useTranslation("components");
  const definition = listConditionalBatchFields().find(
    (field) => field.id === condition.field,
  );
  if (!definition) return null;
  return (
    <div className={styles.inlineEditor}>
      <ConditionFieldControls condition={condition} onChange={onChange} />
      <ConditionValueEditor
        condition={condition}
        sampleText={sampleText}
        onChange={onChange}
      />
      <TextField
        label={t("styleGuide.note")}
        placeholder={t("batchEditorCopy.optional")}
        value={condition.note ?? ""}
        maxLength={500}
        onChange={(event) =>
          onChange({
            ...condition,
            note: event.target.value || undefined,
          })
        }
      />
    </div>
  );
}

function ConditionOrderingButtons({
  total,
  index,
  onMove,
  onDuplicate,
  onRemove,
  canDuplicate,
  canRemove,
}: {
  total: number;
  index: number;
  onMove: (offset: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  canDuplicate: boolean;
  canRemove: boolean;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.rowActions}>
      {total > 1 ? (
        <>
          <IconButton
            size="sm"
            label={t("batchEditorCopy.moveConditionUp")}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <IconArrowUp size={14} />
          </IconButton>
          <IconButton
            size="sm"
            label={t("batchEditorCopy.moveConditionDown")}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            <IconArrowDown size={14} />
          </IconButton>
        </>
      ) : null}
      <IconButton
        size="sm"
        label={t("batchEditorMessages.duplicateCondition", {
          p0: index + 1,
        })}
        disabled={!canDuplicate}
        onClick={onDuplicate}
      >
        <IconCopy size={14} />
      </IconButton>
      <IconButton
        size="sm"
        variant="danger"
        label={t("batchEditorMessages.deleteCondition", {
          p0: index + 1,
        })}
        disabled={!canRemove}
        onClick={onRemove}
      >
        <IconTrash size={14} />
      </IconButton>
    </div>
  );
}

function ConditionSummary({
  condition,
  expanded,
  onExpand,
  evaluation,
}: {
  condition: ConditionalBatchConditionV2;
  expanded: boolean;
  onExpand: () => void;
  evaluation:
    ConditionalBatchPreviewResult["conditionEvaluations"][number] | undefined;
}) {
  const { t } = useTranslation("components");
  const { options: fontOptions } = useFonts();
  const { options: speakerOptions } = React.useContext(
    ConditionalBatchSpeakersContext,
  );

  const identityLabel = conditionIdentityLabel(
    condition,
    fontOptions,
    speakerOptions,
    t("batchEditorCopy.defaultValue"),
  );

  return (
    <UiButton
      type="button"
      className={styles.sentenceSummary}
      aria-expanded={expanded}
      onClick={onExpand}
      variant="bare"
    >
      <span>
        {expanded
          ? CONDITIONAL_BATCH_FIELD_LABELS[condition.field]
          : summarizeCondition(condition, identityLabel)}
      </span>
      {!expanded && evaluation ? (
        <small data-matched={evaluation.matched}>
          {evaluation.matched
            ? t("mcp.pass")
            : t("batchEditorCopy.doesNotMatch")}{" "}
          ·{" "}
          {(evaluation.field === "speakerId"
            ? speakerOptions.find(
                (speaker) => speaker.value === evaluation.rawValue,
              )?.label
            : undefined) ??
            formatConditionalBatchDisplayValue(
              evaluation.field,
              evaluation.rawValue,
            )}
        </small>
      ) : null}
    </UiButton>
  );
}

function ConditionFieldControls({
  condition,
  onChange,
}: {
  condition: ConditionalBatchConditionV2;
  onChange: (condition: ConditionalBatchConditionV2) => void;
}) {
  const { t } = useTranslation("components");
  return (
    <div className={styles.conditionControls}>
      <Field as="div" label={t("batchEditorCopy.field")}>
        <Select
          ariaLabel={t("batchEditorCopy.conditionField")}
          searchable
          value={condition.field}
          options={listConditionalBatchFields()
            .filter(
              (field) =>
                field.id === condition.field ||
                isNewConditionalBatchConditionField(field.id),
            )
            .map((field) => ({
              value: field.id,
              label: field.label,
              group: field.categoryLabel,
              searchText: `${field.label} ${field.id} ${field.categoryLabel}`,
            }))}
          onValueChange={(field) =>
            onChange({
              ...createConditionForField(field as ConditionalBatchField),
              id: condition.id,
              enabled: condition.enabled,
              note: condition.note,
            })
          }
        />
      </Field>
      <Field as="div" label={t("batchEditorCopy.compare")}>
        <Select
          ariaLabel={t("conditionalBatch.when.operator")}
          value={condition.operator}
          options={conditionOperators(condition).map((operator) => ({
            value: operator,
            label: CONDITIONAL_BATCH_OPERATOR_LABELS[operator],
          }))}
          onValueChange={(operator) =>
            onChange(
              conditionValueForOperator(
                condition,
                operator as ConditionalBatchOperator,
              ),
            )
          }
        />
      </Field>
    </div>
  );
}

function conditionIdentityLabel(
  condition: ConditionalBatchConditionV2,
  fontOptions: ReturnType<typeof useFonts>["options"],
  speakerOptions: React.ContextType<
    typeof ConditionalBatchSpeakersContext
  >["options"],
  defaultFontLabel: string,
) {
  const speakerLabel =
    condition.field === "speakerId" &&
    ["equals", "notEquals"].includes(condition.operator)
      ? speakerOptions.find((speaker) => speaker.value === condition.value)
          ?.label
      : undefined;
  const fontLabel =
    condition.field === "fontFamily"
      ? (fontOptions.find((font) => font.id === condition.value)?.label ??
        (condition.value ? String(condition.value) : defaultFontLabel))
      : undefined;
  return speakerLabel ?? fontLabel;
}
