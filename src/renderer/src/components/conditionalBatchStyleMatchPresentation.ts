import { appI18n } from "../appI18n";

import { DEFAULT_BLOCK_FONT_ID } from "../../../shared/blockFontCatalog";
import {
  createConditionalBatchClientId,
  type ConditionalBatchTextStyleField,
  type ConditionalBatchTextStyleMatchCondition,
  type ConditionalBatchWritableField,
} from "../../../shared/conditionalBatchRules";

const t = appI18n.getFixedT(null, "components");

export const TEXT_STYLE_FIELD_LABELS: Record<
  ConditionalBatchTextStyleField,
  string
> = {
  get bold() {
    return t("format.bold");
  },
  get italic() {
    return t("format.italicShort");
  },
  get underline() {
    return t("format.characterFormat.underline");
  },
  get strikethrough() {
    return t("format.characterFormat.strikethrough");
  },
  get emphasisMark() {
    return t("format.characterFormat.emphasisMark");
  },
  get fontFamily() {
    return t("formatBatch.groups.font");
  },
  get sizePx() {
    return t("format.size");
  },
  get opacity() {
    return t("batchEditorCopy.textOpacity");
  },
  get widthScale() {
    return t("format.fontWidth");
  },
  get color() {
    return t("format.textColor");
  },
  get backgroundColor() {
    return t("batchEditorCopy.textBackgroundColor");
  },
  get outlineColor() {
    return t("batchEditorCopy.outlineColor");
  },
  get outlineWidthPx() {
    return t("settings.format.color.outlineWidth");
  },
  get outerOutlineColor() {
    return t("batchEditorCopy.outerOutlineColor");
  },
  get outerOutlineWidthPx() {
    return t("format.outerOutline.width");
  },
  get glowColor() {
    return t("batchEditorCopy.glowColor");
  },
  get glowBlurPx() {
    return t("batchEditorCopy.glowSpread");
  },
  get glowOpacity() {
    return t("batchEditorCopy.glowOpacity");
  },
};

export function createTextStyleMatchCondition(
  field: ConditionalBatchTextStyleField,
  id = createConditionalBatchClientId("style-condition"),
): ConditionalBatchTextStyleMatchCondition {
  if (field === "fontFamily") {
    return { id, field, operator: "equals", value: DEFAULT_BLOCK_FONT_ID };
  }
  if (isTextStyleColorField(field)) {
    return { id, field, operator: "equals", value: "#000000" };
  }
  if (field === "sizePx") {
    return { id, field, operator: "greaterThanOrEqual", value: 24 };
  }
  if (field === "opacity" || field === "glowOpacity") {
    return { id, field, operator: "lessThanOrEqual", value: 1 };
  }
  if (field === "widthScale") {
    return { id, field, operator: "greaterThanOrEqual", value: 1 };
  }
  if (
    field === "outlineWidthPx" ||
    field === "outerOutlineWidthPx" ||
    field === "glowBlurPx"
  ) {
    return { id, field, operator: "greaterThanOrEqual", value: 1 };
  }
  return { id, field, operator: "equals", value: true };
}

export function textStyleOperatorOptions(
  field: ConditionalBatchTextStyleField,
) {
  if (field === "fontFamily" || isTextStyleColorField(field)) {
    return [
      {
        value: "equals",
        label: t("batchEditorCopy.equals"),
      },
      {
        value: "notEquals",
        label: t("batchEditorCopy.notEqual"),
      },
    ];
  }
  if (isTextStyleBooleanField(field)) {
    return [
      {
        value: "equals",
        label: t("pageList.timing.workflow.status"),
      },
    ];
  }
  return [
    {
      value: "equals",
      label: t("batchEditorCopy.equals"),
    },
    {
      value: "notEquals",
      label: t("batchEditorCopy.notEqual"),
    },
    {
      value: "greaterThan",
      label: t("batchEditorCopy.greaterThan"),
    },
    {
      value: "greaterThanOrEqual",
      label: t("batchEditorCopy.atLeast"),
    },
    {
      value: "lessThan",
      label: t("batchEditorCopy.lessThan"),
    },
    {
      value: "lessThanOrEqual",
      label: t("batchEditorCopy.atMost"),
    },
    {
      value: "between",
      label: t("batchEditorCopy.range"),
    },
  ];
}

export function isTextStyleBooleanField(
  field: ConditionalBatchTextStyleField,
): boolean {
  return [
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "emphasisMark",
  ].includes(field);
}

export function isTextStyleColorField(
  field: ConditionalBatchTextStyleField,
): boolean {
  return [
    "color",
    "backgroundColor",
    "outlineColor",
    "outerOutlineColor",
    "glowColor",
  ].includes(field);
}

export function textStyleNumberField(
  field: ConditionalBatchTextStyleField,
): ConditionalBatchWritableField {
  if (field === "opacity") return "textOpacity";
  if (field === "glowOpacity") return "textGlowOpacity";
  if (field === "widthScale") return "fontWidthScale";
  if (field === "glowBlurPx") return "textGlowBlur";
  if (field === "outlineWidthPx" || field === "outerOutlineWidthPx") {
    return field;
  }
  return "fontSizePx";
}
