import { getConditionalBatchFieldDefinition } from "../../../shared/conditionalBatchFieldRegistry";
import {
  isRequiredConditionalBatchWritableField,
  type ConditionalBatchSetFieldChangeV2,
  type ConditionalBatchWritableField,
} from "../../../shared/conditionalBatchRules";
import { conditionalBatchEnumOptions } from "./conditionalBatchUi";

export type ConditionalBatchNumberPresentation = {
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  toStoredValue: (value: number) => number;
};

export function resolveConditionalBatchNumberPresentation(
  field: ConditionalBatchWritableField,
  value: number,
): ConditionalBatchNumberPresentation {
  const number = getConditionalBatchFieldDefinition(field).number;
  if (!number) {
    throw new Error(`숫자 속성 정의가 없습니다: ${field}`);
  }
  if (PERCENT_FIELDS.has(field)) {
    return {
      value: cleanNumber(value * 100),
      min: cleanNumber(number.min * 100),
      max: cleanNumber(number.max * 100),
      step: cleanNumber(number.step * 100),
      unit: "%",
      toStoredValue: (next) => cleanNumber(next / 100),
    };
  }
  return {
    value,
    min: number.min,
    max: number.max,
    step: number.step,
    unit:
      number.unit ??
      (field === "lineHeight" || field === "outlineWidthScale" ? "×" : ""),
    toStoredValue: cleanNumber,
  };
}

export function createConditionalBatchSetFieldChange(
  field: ConditionalBatchWritableField,
): ConditionalBatchSetFieldChangeV2 {
  const definition = getConditionalBatchFieldDefinition(field);
  if (definition.kind === "boolean") {
    return { field, operation: "set", value: true };
  }
  if (definition.kind === "number") {
    return {
      field,
      operation: "set",
      value: definition.number?.defaultValue ?? 0,
    };
  }
  if (definition.kind === "color") {
    return {
      field,
      operation: "set",
      value: DEFAULT_SET_FIELD_COLORS[field] ?? "#000000",
    };
  }
  if (definition.kind === "enum") {
    return {
      field,
      operation: "set",
      value: conditionalBatchEnumOptions(field)[0]?.value ?? "",
    };
  }
  return { field, operation: "set", value: "" };
}

export function isConditionalBatchSetFieldClearable(
  field: ConditionalBatchWritableField,
): boolean {
  return !isRequiredConditionalBatchWritableField(field);
}

/** Adds effect-enabling fields only for newly authored UI rules. */
export function appendConditionalBatchSetFieldDependencies(
  changes: readonly ConditionalBatchSetFieldChangeV2[],
  field: ConditionalBatchWritableField,
): ConditionalBatchSetFieldChangeV2[] {
  const next = [...changes];
  const dependency = SET_FIELD_DEPENDENCIES[field];
  if (dependency && !next.some((change) => change.field === dependency.field)) {
    next.push(dependency);
  }
  return next;
}

function cleanNumber(value: number): number {
  return Number(value.toFixed(6));
}

const PERCENT_FIELDS = new Set<ConditionalBatchWritableField>([
  "fontWidthScale",
  "textOpacity",
  "textEffectOpacity",
  "textGlowOpacity",
]);

const DEFAULT_SET_FIELD_COLORS: Partial<
  Record<ConditionalBatchWritableField, string>
> = {
  textColor: "#111111",
  outlineColor: "#ffffff",
  outerOutlineColor: "#111111",
  textBackgroundColor: "#ffffff",
  textEffectColor: "#000000",
  textGlowColor: "#ffffff",
};

const SET_FIELD_DEPENDENCIES: Partial<
  Record<ConditionalBatchWritableField, ConditionalBatchSetFieldChangeV2>
> = {
  textBackgroundColor: {
    field: "textBackgroundEnabled",
    operation: "set",
    value: true,
  },
  outerOutlineColor: {
    field: "outerOutlineWidthPx",
    operation: "set",
    value: 1.5,
  },
  textEffectColor: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textEffectOffsetX: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textEffectOffsetY: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textEffectBlur: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textEffectOpacity: {
    field: "textEffectEnabled",
    operation: "set",
    value: true,
  },
  textGlowColor: {
    field: "textGlowEnabled",
    operation: "set",
    value: true,
  },
  textGlowBlur: {
    field: "textGlowEnabled",
    operation: "set",
    value: true,
  },
  textGlowOpacity: {
    field: "textGlowEnabled",
    operation: "set",
    value: true,
  },
};
