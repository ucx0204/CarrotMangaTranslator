import { appI18n } from "../appI18n";
import {
  formatConditionalBatchFieldValue,
  getConditionalBatchFieldDefinition,
  type ConditionalBatchField,
} from "../../../shared/conditionalBatchFieldRegistry";

import {
  type ConditionalBatchActionV2,
  type ConditionalBatchConditionV2,
  type ConditionalBatchSetFieldChangeV2,
} from "../../../shared/conditionalBatchRules";

import {
  type ConditionalReplacementV3,
  type ConditionalTextMatcherV3,
} from "../../../shared/conditionalTextPattern";

import { conditionalBatchEnumOptions } from "./conditionalBatchUi";
import {
  CONDITIONAL_BATCH_FIELD_LABELS,
  CONDITIONAL_BATCH_OPERATOR_LABELS,
} from "./conditionalBatchLabels";

const t = appI18n.getFixedT(null, "components");

export function summarizeCondition(
  condition: ConditionalBatchConditionV2,
  displayValue?: string,
): string {
  const field = CONDITIONAL_BATCH_FIELD_LABELS[condition.field];
  const operator = CONDITIONAL_BATCH_OPERATOR_LABELS[condition.operator];
  const value =
    condition.operator === "regex" || condition.operator === "notRegex"
      ? summarizeTextMatcher(condition.matcher)
      : (displayValue ??
        (condition.value === undefined
          ? ""
          : formatConditionalBatchDisplayValue(
              condition.field,
              condition.value,
            )));
  const end =
    condition.operator === "between"
      ? ` ${value}–${condition.value2 === undefined ? "" : formatConditionalBatchDisplayValue(condition.field, condition.value2)}`
      : value
        ? ` “${value}”`
        : "";
  return t("batchEditorMessages.condition", {
    p0: field,
    p1: operator,
    p2: end,
  });
}

export function summarizeAction(action: ConditionalBatchActionV2): string {
  if (action.type === "replaceText") {
    return t("batchEditorMessages.replaceWith", {
      p0: summarizeTextMatcher(action.matcher),
      p1: summarizeReplacement(action.replacement),
      p2: action.allOccurrences
        ? appI18n.t("batchEditorCopy.all", { ns: "components" })
        : appI18n.t("batchEditorCopy.firstOnly", { ns: "components" }),
    });
  }
  if (action.type === "applyStylePreset") {
    return t("batchEditorMessages.applyPreset", {
      p0: action.presetName,
    });
  }
  if (action.type === "setFields") {
    return action.changes.map(summarizeSetFieldChange).join(" · ");
  }
  const target =
    action.scope === "allText"
      ? t("batchEditorCopy.allText")
      : summarizeTextMatcher(action.matcher);
  return t("batchEditorMessages.applyPartialFormattingTo", {
    p0: target,
  });
}

function summarizeSetFieldChange(
  change: ConditionalBatchSetFieldChangeV2,
): string {
  const label = CONDITIONAL_BATCH_FIELD_LABELS[change.field];
  if (change.operation === "clear")
    return t("batchEditorMessages.clearOverride", {
      p0: label,
    });
  const definition = getConditionalBatchFieldDefinition(change.field);
  if (definition.kind === "boolean") {
    return summarizeBooleanSetField(label, change.value);
  }
  if (definition.kind === "enum") {
    return summarizeEnumSetField(label, change);
  }
  if (definition.kind === "number") {
    return `${label} ${formatConditionalBatchDisplayValue(change.field, change.value)}`;
  }
  const value = String(change.value ?? "");
  return `${label} ${value || t("batchEditorCopy.emptyValue")}`;
}

function summarizeBooleanSetField(
  label: string,
  value: ConditionalBatchSetFieldChangeV2["value"],
): string {
  return `${label} ${value === true ? t("batchEditorCopy.on") : t("batchEditorCopy.off")}`;
}

function summarizeEnumSetField(
  label: string,
  change: ConditionalBatchSetFieldChangeV2,
): string {
  const rawValue = String(change.value ?? "");
  const option = conditionalBatchEnumOptions(change.field).find(
    (entry) => entry.value === rawValue,
  );
  return `${label} ${option?.label ?? rawValue}`;
}

export function resolveConditionalBatchNumberPresentation(
  field: ConditionalBatchField,
  value: number,
) {
  const number = getConditionalBatchFieldDefinition(field).number;
  const scale = PERCENT_VALUE_FIELDS.has(field) ? 100 : 1;
  return {
    value: cleanNumber(value * scale),
    min: number ? cleanNumber(number.min * scale) : Number.MIN_SAFE_INTEGER,
    max: number ? cleanNumber(number.max * scale) : Number.MAX_SAFE_INTEGER,
    step: number ? cleanNumber(number.step * scale) : 0.01,
    unit:
      scale === 100
        ? "%"
        : (number?.unit ?? (field === "outlineWidthScale" ? "×" : "")),
    toStoredValue: (next: number) => cleanNumber(next / scale),
  };
}

export function formatConditionalBatchDisplayValue(
  field: ConditionalBatchField,
  value: unknown,
): string {
  if (typeof value === "number") {
    const presentation = resolveConditionalBatchNumberPresentation(
      field,
      value,
    );
    return `${presentation.value}${presentation.unit}`;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => formatConditionalBatchDisplayValue(field, item))
      .join(", ");
  }
  return (
    conditionalBatchEnumOptions(field).find((option) => option.value === value)
      ?.label ??
    formatConditionalBatchFieldValue(
      typeof value === "string" || typeof value === "boolean"
        ? value
        : undefined,
    )
  );
}

function cleanNumber(value: number): number {
  return Number(value.toFixed(6));
}

const PERCENT_VALUE_FIELDS = new Set<ConditionalBatchField>([
  "lineHeight",
  "fontWidthScale",
  "textOpacity",
  "textEffectOpacity",
  "textGlowOpacity",
  "confidence",
  "fontRoleConfidence",
]);

function summarizeTextMatcher(
  matcher: ConditionalTextMatcherV3 | undefined,
): string {
  if (!matcher) return t("batchEditorCopy.pattern");
  if (matcher.mode === "regex") return t("batchEditorCopy.advancedPattern");
  if (matcher.nodes.length === 1 && matcher.nodes[0]?.kind === "literal") {
    return `“${matcher.nodes[0].text}”`;
  }
  return matcher.nodes
    .map((node) => {
      if (node.kind === "literal") return `“${node.text}”`;
      if (node.kind === "character") {
        return {
          number: t("batchEditorCopy.number"),
          letter: t("batchEditorCopy.character"),
          whitespace: t("batchEditorCopy.whitespace"),
          newline: t("patternEditorCopy.lineBreak"),
          any: t("batchEditorCopy.anyCharacter"),
        }[node.character];
      }
      if (node.kind === "choice")
        return node.options.join(t("batchEditorCopy.orSeparator"));
      if (node.kind === "group") return t("batchEditorCopy.group");
      return node.boundary === "start"
        ? t("batchEditorCopy.balloonStart")
        : t("batchEditorCopy.balloonEnd");
    })
    .join(" + ");
}

function summarizeReplacement(replacement: ConditionalReplacementV3): string {
  if (replacement.mode === "raw")
    return t("batchEditorCopy.advancedReplacement");
  if (replacement.parts.length === 0) return t("batchEditorCopy.emptyText");
  return replacement.parts
    .map((part) =>
      part.kind === "literal"
        ? `“${part.text}”`
        : t("batchEditorCopy.rememberedPart"),
    )
    .join(" + ");
}
