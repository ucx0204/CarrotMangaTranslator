import { appI18n } from "../appI18n";

import { readConditionalBatchWritableValue } from "../../../shared/conditionalBatchEngine";
import {
  type ConditionalBatchPreview,
  type ConditionalBatchPreviewResult,
  type ConditionalBatchWritableField,
} from "../../../shared/conditionalBatchRules";
import { stripRichTextMarkup } from "../../../shared/richTextMarkup";

import { formatConditionalBatchDisplayValue } from "./conditionalBatchPresentation";
import { conditionalBatchEnumOptions } from "./conditionalBatchUi";
import { CONDITIONAL_BATCH_FIELD_LABELS } from "./conditionalBatchLabels";

const t = appI18n.getFixedT(null, "components");

export function readChangedField(
  block: ConditionalBatchPreviewResult["beforeBlock"],
  field: ConditionalBatchWritableField,
  resolvedValue?: unknown,
): string {
  const value =
    resolvedValue ?? readConditionalBatchWritableValue(block, field);
  if (field === "translatedText") {
    return stripRichTextMarkup(String(value ?? ""));
  }
  if (value === undefined) return t("batchEditorCopy.notSpecified");
  if (value === "") return t("conditionalBatch.when.empty");
  if (typeof value === "boolean")
    return readChangedBoolean(block, field, value);
  if (typeof value === "number")
    return formatConditionalBatchDisplayValue(field, value);
  if (typeof value === "object") return JSON.stringify(value);
  const rawValue = String(value);
  return (
    conditionalBatchEnumOptions(field).find(
      (option) => option.value === rawValue,
    )?.label ?? rawValue
  );
}

function readChangedBoolean(
  block: ConditionalBatchPreviewResult["beforeBlock"],
  field: ConditionalBatchWritableField,
  value: boolean,
): string {
  const state = value ? t("gatherText.toggleOn") : t("gatherText.toggleOff");
  return field === "bold" && block.fontWeight !== undefined
    ? t("batchEditorMessages.weight", {
        p0: state,
        p1: block.fontWeight,
      })
    : state;
}

export function resultListSummary(
  result: ConditionalBatchPreviewResult,
  preview: ConditionalBatchPreview,
): string {
  if (preview.inspectionOnly) {
    return (
      stripRichTextMarkup(result.beforeBlock.translatedText) ||
      t("batchEditorCopy.emptyTranslation")
    );
  }
  const first = result.changedFields[0];
  if (!first) return t("batchEditorCopy.unchanged76");
  const remainingCount = result.changedFields.length - 1;
  const remaining =
    remainingCount > 0
      ? t("batchEditorMessages.more", { p0: remainingCount })
      : "";
  const afterValue = readConditionalBatchWritableValue(
    result.afterBlock,
    first,
  );
  const outcome =
    afterValue === undefined
      ? t("batchEditorCopy.clearValue")
      : t("batchEditorMessages.apply", {
          p0: readChangedField(
            result.afterBlock,
            first,
            result.resolvedFieldValues?.[first]?.after,
          ),
        });
  return `${CONDITIONAL_BATCH_FIELD_LABELS[first]} · ${outcome}${remaining}`;
}

export function actionTypeLabel(
  type: ConditionalBatchPreviewResult["actionTrace"][number]["actionType"],
): string {
  if (type === "replaceText") return t("batchEditorCopy.findAndReplace");
  if (type === "setFields") return t("batchEditorCopy.changeProperties");
  if (type === "applyStylePreset") return t("batchEditorCopy.stylePreset");
  return t("batchEditorCopy.inlineFormatting");
}
