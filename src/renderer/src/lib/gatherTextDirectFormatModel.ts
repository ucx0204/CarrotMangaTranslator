import { DEFAULT_BLOCK_FONT_ID } from "../../../shared/blockFontCatalog";
import type { TranslationBlock } from "../../../shared/textTypes";

export const GATHER_TEXT_DIRECT_FORMAT_FIELDS = [
  "fontFamily",
  "fontSizePx",
  "autoFitText",
  "textAlign",
  "renderDirection",
  "bold",
  "italic",
  "lineHeight",
  "letterSpacing",
  "fontWidthScale",
  "textColor",
  "textOpacity",
  "outlineColor",
  "outlineWidthScale",
  "rotationDeg",
] as const;

export type GatherTextDirectFormatField =
  (typeof GATHER_TEXT_DIRECT_FORMAT_FIELDS)[number];

export type GatherTextDirectFormatValues = {
  fontFamily: string | undefined;
  fontSizePx: number;
  autoFitText: boolean;
  textAlign: TranslationBlock["textAlign"];
  renderDirection: TranslationBlock["renderDirection"];
  bold: boolean;
  italic: boolean;
  lineHeight: number;
  letterSpacing: number;
  fontWidthScale: number;
  textColor: string;
  textOpacity: number;
  outlineColor: string | undefined;
  outlineWidthScale: number;
  rotationDeg: number;
};

export type GatherTextDirectFormatPatch = Partial<
  Pick<TranslationBlock, GatherTextDirectFormatField>
>;

export type GatherTextDirectFormatValueState<T> =
  | { kind: "common"; value: T }
  | { kind: "mixed" };

export type GatherTextDirectFormatValueStates = {
  [Field in GatherTextDirectFormatField]: GatherTextDirectFormatValueState<
    GatherTextDirectFormatValues[Field]
  >;
};

export type GatherTextDirectFormatModel = {
  hasSelection: boolean;
  previewValues: GatherTextDirectFormatValues | null;
  selectionCount: number;
  values: GatherTextDirectFormatValueStates;
};

const DIRECT_FORMAT_FIELD_SET: ReadonlySet<string> = new Set(
  GATHER_TEXT_DIRECT_FORMAT_FIELDS,
);

export function deriveGatherTextDirectFormatModel(
  blocks: readonly TranslationBlock[],
): GatherTextDirectFormatModel {
  if (blocks.length === 0) {
    return {
      hasSelection: false,
      previewValues: null,
      selectionCount: 0,
      values: createAllMixedStates(),
    };
  }

  const first = normalizeDirectFormatValues(blocks[0]);
  const states: Record<string, unknown> = {};
  for (const field of GATHER_TEXT_DIRECT_FORMAT_FIELDS) {
    const value = first[field];
    states[field] = blocks
      .slice(1)
      .every((block) =>
        Object.is(normalizeDirectFormatValue(block, field), value),
      )
      ? { kind: "common", value }
      : { kind: "mixed" };
  }

  return {
    hasSelection: true,
    previewValues: first,
    selectionCount: blocks.length,
    values: states as GatherTextDirectFormatValueStates,
  };
}

export function buildGatherTextDirectFormatPatch<
  Field extends GatherTextDirectFormatField,
>(
  field: Field,
  value: GatherTextDirectFormatValues[Field],
): GatherTextDirectFormatPatch {
  const patch: Record<string, unknown> = {};
  patch[field] = value;
  return patch as GatherTextDirectFormatPatch;
}

export function mergeGatherTextDirectFormatPatch(
  base: Partial<TranslationBlock>,
  ...updates: readonly Partial<TranslationBlock>[]
): GatherTextDirectFormatPatch {
  const merged: Record<string, unknown> = {};
  for (const source of [base, ...updates]) {
    for (const field of GATHER_TEXT_DIRECT_FORMAT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(source, field)) {
        merged[field] = source[field];
      }
    }
  }
  return merged as GatherTextDirectFormatPatch;
}

export function isGatherTextDirectFormatPatchEmpty(
  patch: Partial<TranslationBlock>,
): boolean {
  return !Object.keys(patch).some((field) =>
    DIRECT_FORMAT_FIELD_SET.has(field),
  );
}

function normalizeDirectFormatValues(
  block: TranslationBlock,
): GatherTextDirectFormatValues {
  return {
    fontFamily: normalizeFontFamily(block.fontFamily),
    fontSizePx: block.fontSizePx,
    autoFitText: block.autoFitText ?? true,
    textAlign: block.textAlign,
    renderDirection: block.renderDirection,
    bold: block.bold ?? false,
    italic: block.italic ?? false,
    lineHeight: block.lineHeight,
    letterSpacing: block.letterSpacing ?? 0,
    fontWidthScale: block.fontWidthScale ?? 1,
    textColor: block.textColor,
    textOpacity: block.textOpacity ?? 1,
    outlineColor: block.outlineColor,
    outlineWidthScale: block.outlineWidthScale ?? 1,
    rotationDeg: block.rotationDeg ?? 0,
  };
}

function normalizeDirectFormatValue<Field extends GatherTextDirectFormatField>(
  block: TranslationBlock,
  field: Field,
): GatherTextDirectFormatValues[Field] {
  return normalizeDirectFormatValues(block)[field];
}

function normalizeFontFamily(value: string | undefined): string | undefined {
  return !value || value === DEFAULT_BLOCK_FONT_ID ? undefined : value;
}

function createAllMixedStates(): GatherTextDirectFormatValueStates {
  return Object.fromEntries(
    GATHER_TEXT_DIRECT_FORMAT_FIELDS.map((field) => [field, { kind: "mixed" }]),
  ) as GatherTextDirectFormatValueStates;
}
