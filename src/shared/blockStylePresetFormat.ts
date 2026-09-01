import type { BlockFormatDefaults, BlockFormatGroupId } from "./blockFormat";
import type { TranslationBlock } from "./textTypes";
import {
  DEFAULT_TEXT_EFFECT,
  cloneTextEffect,
  normalizeTextEffect,
} from "./textEffect";
import {
  DEFAULT_TEXT_GLOW,
  cloneTextGlow,
  normalizeTextGlow,
} from "./textGlow";
import {
  MAX_FONT_SIZE_PX,
  MAX_FONT_WIDTH_SCALE,
  MAX_LETTER_SPACING_EM,
  MAX_LINE_HEIGHT,
  MIN_FONT_SIZE_PX,
  MIN_FONT_WIDTH_SCALE,
  MIN_LETTER_SPACING_EM,
  MIN_LINE_HEIGHT,
} from "./blockFormatValues";
import {
  asRecord,
  booleanValue,
  buildFormat,
  colorValue,
  enumValue,
  optionalColor,
  optionalRangedNumber,
  optionalString,
  rangedNumber,
} from "./blockStylePresetFormatUtils";

export type BlockStylePresetFormat = Partial<
  Pick<
    TranslationBlock,
    | "fontFamily"
    | "fontSizePx"
    | "autoFitText"
    | "textAlign"
    | "wordBreak"
    | "renderDirection"
    | "bold"
    | "italic"
    | "underline"
    | "strikethrough"
    | "emphasisMark"
    | "lineHeight"
    | "letterSpacing"
    | "fontWidthScale"
    | "textColor"
    | "textBackgroundEnabled"
    | "textBackgroundColor"
    | "textOpacity"
    | "outlineColor"
    | "outlineWidthPx"
    | "outlineWidthScale"
    | "outerOutlineColor"
    | "outerOutlineWidthPx"
    | "textEffect"
    | "textGlow"
    | "rotationDeg"
  >
>;

type BlockStylePresetLike = {
  groupIds: readonly BlockFormatGroupId[];
  format: BlockStylePresetFormat;
};

type FormatBuilder<Source> = (source: Source) => BlockStylePresetFormat;

const BLOCK_FORMAT_BUILDERS: Record<
  BlockFormatGroupId,
  FormatBuilder<TranslationBlock>
> = {
  font: (block) => ({ fontFamily: block.fontFamily }),
  size: (block) => ({
    fontSizePx: block.fontSizePx,
    autoFitText: block.autoFitText ?? true,
  }),
  align: (block) => ({ textAlign: block.textAlign }),
  wordBreak: (block) => ({ wordBreak: block.wordBreak }),
  direction: (block) => ({ renderDirection: block.renderDirection }),
  emphasis: (block) => ({
    bold: block.bold ?? false,
    italic: block.italic ?? false,
    ...(block.underline === undefined ? {} : { underline: block.underline }),
    ...(block.strikethrough === undefined
      ? {}
      : { strikethrough: block.strikethrough }),
    ...(block.emphasisMark === undefined
      ? {}
      : { emphasisMark: block.emphasisMark }),
  }),
  lineSpacing: (block) => ({ lineHeight: block.lineHeight }),
  letterSpacing: (block) => ({ letterSpacing: block.letterSpacing ?? 0 }),
  fontWidth: (block) => ({ fontWidthScale: block.fontWidthScale ?? 1 }),
  color: (block) => ({
    textColor: block.textColor,
    ...(block.textBackgroundEnabled === undefined
      ? {}
      : { textBackgroundEnabled: block.textBackgroundEnabled }),
    ...(block.textBackgroundColor === undefined
      ? {}
      : { textBackgroundColor: block.textBackgroundColor }),
  }),
  outline: (block) => ({
    outlineColor: block.outlineColor,
    ...(block.outlineWidthPx === undefined
      ? { outlineWidthScale: block.outlineWidthScale ?? 0 }
      : { outlineWidthPx: block.outlineWidthPx }),
    ...(block.outerOutlineColor === undefined
      ? {}
      : { outerOutlineColor: block.outerOutlineColor }),
    ...(block.outerOutlineWidthPx === undefined
      ? {}
      : { outerOutlineWidthPx: block.outerOutlineWidthPx }),
  }),
  effect: (block) => ({
    ...(block.textEffect
      ? { textEffect: cloneTextEffect(block.textEffect) }
      : {}),
    ...(block.textGlow ? { textGlow: cloneTextGlow(block.textGlow) } : {}),
  }),
  transform: (block) => ({
    rotationDeg: block.rotationDeg ?? 0,
    textOpacity: block.textOpacity ?? 1,
  }),
};

const DEFAULT_FORMAT_BUILDERS: Record<
  BlockFormatGroupId,
  FormatBuilder<BlockFormatDefaults>
> = {
  font: (defaults) => ({ fontFamily: defaults.fontFamily }),
  size: (defaults) => ({
    fontSizePx: defaults.fontSizePx,
    autoFitText: defaults.autoFitText,
  }),
  align: (defaults) => ({ textAlign: defaults.textAlign }),
  wordBreak: (defaults) => ({ wordBreak: defaults.wordBreak }),
  direction: (defaults) =>
    defaults.renderDirection === "auto"
      ? {}
      : { renderDirection: defaults.renderDirection },
  emphasis: (defaults) => ({
    bold: defaults.bold,
    italic: defaults.italic,
  }),
  lineSpacing: (defaults) => ({ lineHeight: defaults.lineHeight }),
  letterSpacing: (defaults) => ({ letterSpacing: defaults.letterSpacing }),
  fontWidth: (defaults) => ({ fontWidthScale: defaults.fontWidthScale }),
  color: (defaults) => ({
    textColor: defaults.textColor,
  }),
  outline: (defaults) => ({
    outlineColor: defaults.outlineEnabled ? defaults.outlineColor : undefined,
    ...(defaults.outlineWidthPx === undefined
      ? {
          outlineWidthScale: defaults.outlineEnabled
            ? defaults.outlineWidthScale
            : 0,
        }
      : {
          outlineWidthPx: defaults.outlineEnabled ? defaults.outlineWidthPx : 0,
        }),
  }),
  effect: () => ({}),
  transform: (defaults) => ({
    rotationDeg: 0,
    textOpacity: defaults.textOpacity,
  }),
};

const NORMALIZED_FORMAT_BUILDERS: Record<
  BlockFormatGroupId,
  FormatBuilder<Record<string, unknown>>
> = {
  font: (record) => ({ fontFamily: optionalString(record.fontFamily, 120) }),
  size: (record) => ({
    fontSizePx: rangedNumber(
      record.fontSizePx,
      MIN_FONT_SIZE_PX,
      MAX_FONT_SIZE_PX,
      24,
    ),
    autoFitText: booleanValue(record.autoFitText, true),
  }),
  align: (record) => ({
    textAlign: enumValue<NonNullable<TranslationBlock["textAlign"]>>(
      record.textAlign,
      ["left", "center", "right"],
      "center",
    ),
  }),
  wordBreak: (record) => ({
    wordBreak: enumValue<NonNullable<TranslationBlock["wordBreak"]>>(
      record.wordBreak,
      ["normal", "break-word", "break-all", "keep-all", "keep-all-overflow"],
      "normal",
    ),
  }),
  direction: (record) => ({
    renderDirection: enumValue<
      NonNullable<TranslationBlock["renderDirection"]>
    >(record.renderDirection, ["horizontal", "vertical"], "horizontal"),
  }),
  emphasis: (record) => ({
    bold: booleanValue(record.bold, false),
    italic: booleanValue(record.italic, false),
    ...(record.underline === undefined
      ? {}
      : { underline: booleanValue(record.underline, false) }),
    ...(record.strikethrough === undefined
      ? {}
      : { strikethrough: booleanValue(record.strikethrough, false) }),
    ...(record.emphasisMark === undefined
      ? {}
      : { emphasisMark: booleanValue(record.emphasisMark, false) }),
  }),
  lineSpacing: (record) => ({
    lineHeight: rangedNumber(
      record.lineHeight,
      MIN_LINE_HEIGHT,
      MAX_LINE_HEIGHT,
      1.18,
    ),
  }),
  letterSpacing: (record) => ({
    letterSpacing: rangedNumber(
      record.letterSpacing,
      MIN_LETTER_SPACING_EM,
      MAX_LETTER_SPACING_EM,
      0,
    ),
  }),
  fontWidth: (record) => ({
    fontWidthScale: rangedNumber(
      record.fontWidthScale,
      MIN_FONT_WIDTH_SCALE,
      MAX_FONT_WIDTH_SCALE,
      1,
    ),
  }),
  color: (record) => ({
    textColor: colorValue(record.textColor, "#111111"),
    ...(record.textBackgroundEnabled === undefined
      ? {}
      : {
          textBackgroundEnabled: booleanValue(
            record.textBackgroundEnabled,
            false,
          ),
        }),
    ...(record.textBackgroundColor === undefined
      ? {}
      : {
          textBackgroundColor: colorValue(
            record.textBackgroundColor,
            "#ffffff",
          ),
        }),
  }),
  outline: (record) => {
    const outlineWidthPx = optionalRangedNumber(record.outlineWidthPx, 0, 64);
    return {
      outlineColor: optionalColor(record.outlineColor),
      ...(outlineWidthPx === undefined
        ? { outlineWidthScale: rangedNumber(record.outlineWidthScale, 0, 8, 0) }
        : { outlineWidthPx }),
      ...(record.outerOutlineColor === undefined
        ? {}
        : { outerOutlineColor: optionalColor(record.outerOutlineColor) }),
      ...(record.outerOutlineWidthPx === undefined
        ? {}
        : {
            outerOutlineWidthPx: rangedNumber(
              record.outerOutlineWidthPx,
              0,
              64,
              0,
            ),
          }),
    };
  },
  effect: (record) => ({
    ...(record.textEffect === undefined
      ? {}
      : {
          textEffect: normalizeTextEffect(record.textEffect) ?? {
            ...DEFAULT_TEXT_EFFECT,
          },
        }),
    ...(record.textGlow === undefined
      ? {}
      : {
          textGlow: normalizeTextGlow(record.textGlow) ?? {
            ...DEFAULT_TEXT_GLOW,
          },
        }),
  }),
  transform: (record) => ({
    rotationDeg: rangedNumber(record.rotationDeg, -180, 180, 0),
    textOpacity: rangedNumber(record.textOpacity, 0, 1, 1),
  }),
};

const PATCH_BUILDERS: Record<
  BlockFormatGroupId,
  FormatBuilder<BlockStylePresetFormat>
> = {
  font: (format) => ({ fontFamily: format.fontFamily }),
  size: (format) => ({
    fontSizePx: format.fontSizePx ?? 24,
    autoFitText: format.autoFitText ?? true,
  }),
  align: (format) => ({ textAlign: format.textAlign ?? "center" }),
  wordBreak: (format) => ({ wordBreak: format.wordBreak ?? "normal" }),
  direction: (format) => ({
    renderDirection: format.renderDirection ?? "horizontal",
  }),
  emphasis: (format) => ({
    bold: format.bold ?? false,
    italic: format.italic ?? false,
    ...(format.underline === undefined ? {} : { underline: format.underline }),
    ...(format.strikethrough === undefined
      ? {}
      : { strikethrough: format.strikethrough }),
    ...(format.emphasisMark === undefined
      ? {}
      : { emphasisMark: format.emphasisMark }),
  }),
  lineSpacing: (format) => ({ lineHeight: format.lineHeight ?? 1.18 }),
  letterSpacing: (format) => ({ letterSpacing: format.letterSpacing ?? 0 }),
  fontWidth: (format) => ({ fontWidthScale: format.fontWidthScale ?? 1 }),
  color: (format) => ({
    textColor: format.textColor ?? "#111111",
    ...(format.textBackgroundEnabled === undefined
      ? {}
      : { textBackgroundEnabled: format.textBackgroundEnabled }),
    ...(format.textBackgroundColor === undefined
      ? {}
      : { textBackgroundColor: format.textBackgroundColor }),
  }),
  outline: (format) => ({
    outlineColor: format.outlineColor,
    ...(format.outlineWidthPx === undefined
      ? { outlineWidthScale: format.outlineWidthScale ?? 0 }
      : { outlineWidthPx: format.outlineWidthPx }),
    ...(format.outerOutlineColor === undefined
      ? {}
      : { outerOutlineColor: format.outerOutlineColor }),
    ...(format.outerOutlineWidthPx === undefined
      ? {}
      : { outerOutlineWidthPx: format.outerOutlineWidthPx }),
  }),
  effect: (format) => ({
    ...(format.textEffect
      ? { textEffect: cloneTextEffect(format.textEffect) }
      : {}),
    ...(format.textGlow ? { textGlow: cloneTextGlow(format.textGlow) } : {}),
  }),
  transform: (format) => ({
    rotationDeg: format.rotationDeg ?? 0,
    textOpacity: format.textOpacity ?? 1,
  }),
};

export function buildBlockStylePresetFormat(
  block: TranslationBlock,
  groupIds: readonly BlockFormatGroupId[],
): BlockStylePresetFormat {
  return buildFormat(block, groupIds, BLOCK_FORMAT_BUILDERS);
}

export function buildDefaultsPresetFormat(
  defaults: BlockFormatDefaults,
  groupIds: readonly BlockFormatGroupId[],
): BlockStylePresetFormat {
  return buildFormat(defaults, groupIds, DEFAULT_FORMAT_BUILDERS);
}

export function normalizePresetFormat(
  value: unknown,
  groupIds: readonly BlockFormatGroupId[],
): BlockStylePresetFormat {
  return buildFormat(
    asRecord(value) ?? {},
    groupIds,
    NORMALIZED_FORMAT_BUILDERS,
  );
}

export function resolveBlockStylePresetPatchFields(
  preset: BlockStylePresetLike,
  options: { omitFont?: boolean },
): Partial<TranslationBlock> {
  const groupIds = options.omitFont
    ? preset.groupIds.filter((groupId) => groupId !== "font")
    : preset.groupIds;
  const patch = buildFormat(preset.format, groupIds, PATCH_BUILDERS);
  if (!groupIds.includes("outline")) return patch;
  return preset.format.outlineWidthPx === undefined
    ? { ...patch, outlineWidthPx: undefined }
    : { ...patch, outlineWidthScale: undefined };
}
