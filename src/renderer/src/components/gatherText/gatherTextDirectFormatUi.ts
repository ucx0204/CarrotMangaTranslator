import type {
  GatherTextDirectFormatField,
  GatherTextDirectFormatModel,
  GatherTextDirectFormatPatch,
  GatherTextDirectFormatValueState,
  GatherTextDirectFormatValues,
  GatherTextDirectFormatValueStates,
} from "../../lib/gatherTextDirectFormatModel";

export type DirectChangeHandler = <Field extends GatherTextDirectFormatField>(
  field: Field,
  value: GatherTextDirectFormatValues[Field],
) => void;

const PREVIEW_DEFAULTS: GatherTextDirectFormatValues = {
  fontFamily: undefined,
  fontSizePx: 28,
  autoFitText: false,
  textAlign: "center",
  renderDirection: "horizontal",
  wordBreak: "normal",
  bold: false,
  italic: false,
  lineHeight: 1.18,
  letterSpacing: 0,
  fontWidthScale: 1,
  textColor: "#f6f1e8",
  textOpacity: 1,
  outlineColor: "#111111",
  outlineWidthScale: 1,
  rotationDeg: 0,
};

export function resolveControlState<Field extends GatherTextDirectFormatField>(
  states: GatherTextDirectFormatValueStates,
  patch: GatherTextDirectFormatPatch,
  field: Field,
): GatherTextDirectFormatValueState<GatherTextDirectFormatValues[Field]> {
  if (hasDirectFormatField(patch, field)) {
    return {
      kind: "common",
      value: patch[field] as GatherTextDirectFormatValues[Field],
    };
  }
  return states[field] as GatherTextDirectFormatValueState<
    GatherTextDirectFormatValues[Field]
  >;
}

export function resolvePreviewValues(
  model: GatherTextDirectFormatModel,
  patch: GatherTextDirectFormatPatch,
): GatherTextDirectFormatValues {
  return Object.fromEntries(
    (Object.keys(PREVIEW_DEFAULTS) as GatherTextDirectFormatField[]).map(
      (field) => [field, resolvePreviewValue(model, patch, field)],
    ),
  ) as GatherTextDirectFormatValues;
}

export function resolvePreviewValue<Field extends GatherTextDirectFormatField>(
  model: GatherTextDirectFormatModel,
  patch: GatherTextDirectFormatPatch,
  field: Field,
): GatherTextDirectFormatValues[Field] {
  if (hasDirectFormatField(patch, field)) {
    return patch[field] as GatherTextDirectFormatValues[Field];
  }
  return (model.previewValues?.[field] ??
    PREVIEW_DEFAULTS[field]) as GatherTextDirectFormatValues[Field];
}

export function resolvePreviewOutline(
  fontSizePx: number,
  color: string,
  scale: number,
): string {
  if (scale <= 0) return "none";
  const width = Math.max(0.6, fontSizePx * 0.032 * scale);
  return [
    [-width, 0],
    [width, 0],
    [0, -width],
    [0, width],
    [-width, -width],
    [width, -width],
    [-width, width],
    [width, width],
  ]
    .map(([x, y]) => `${x}px ${y}px 0 ${color}`)
    .join(", ");
}

export function hasDirectFormatField(
  patch: GatherTextDirectFormatPatch,
  field: GatherTextDirectFormatField,
): boolean {
  return Object.prototype.hasOwnProperty.call(patch, field);
}

export function clampDirectFormatValue(
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
