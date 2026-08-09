import type { BlockFormatDefaults, BlockFormatGroupId } from "./blockFormat";
import type { TranslationBlock } from "./textTypes";

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
    | "lineHeight"
    | "letterSpacing"
    | "fontWidthScale"
    | "textColor"
    | "textOpacity"
    | "outlineColor"
    | "outlineWidthScale"
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
  }),
  lineSpacing: (block) => ({ lineHeight: block.lineHeight }),
  letterSpacing: (block) => ({ letterSpacing: block.letterSpacing ?? 0 }),
  fontWidth: (block) => ({ fontWidthScale: block.fontWidthScale ?? 1 }),
  color: (block) => ({ textColor: block.textColor }),
  outline: (block) => ({
    outlineColor: block.outlineColor,
    outlineWidthScale: block.outlineWidthScale ?? 0,
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
  color: (defaults) => ({ textColor: defaults.textColor }),
  outline: (defaults) => ({
    outlineColor: defaults.outlineEnabled ? defaults.outlineColor : undefined,
    outlineWidthScale: defaults.outlineEnabled ? defaults.outlineWidthScale : 0,
  }),
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
    fontSizePx: rangedNumber(record.fontSizePx, 1, 512, 24),
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
      ["normal", "break-all", "keep-all", "break-word"],
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
  }),
  lineSpacing: (record) => ({
    lineHeight: rangedNumber(record.lineHeight, 0.5, 4, 1.18),
  }),
  letterSpacing: (record) => ({
    letterSpacing: rangedNumber(record.letterSpacing, -0.5, 2, 0),
  }),
  fontWidth: (record) => ({
    fontWidthScale: rangedNumber(record.fontWidthScale, 0.5, 1.5, 1),
  }),
  color: (record) => ({
    textColor: colorValue(record.textColor, "#111111"),
  }),
  outline: (record) => ({
    outlineColor: optionalColor(record.outlineColor),
    outlineWidthScale: rangedNumber(record.outlineWidthScale, 0, 8, 0),
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
  }),
  lineSpacing: (format) => ({ lineHeight: format.lineHeight ?? 1.18 }),
  letterSpacing: (format) => ({ letterSpacing: format.letterSpacing ?? 0 }),
  fontWidth: (format) => ({ fontWidthScale: format.fontWidthScale ?? 1 }),
  color: (format) => ({ textColor: format.textColor ?? "#111111" }),
  outline: (format) => ({
    outlineColor: format.outlineColor,
    outlineWidthScale: format.outlineWidthScale ?? 0,
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
  return buildFormat(preset.format, groupIds, PATCH_BUILDERS);
}

function buildFormat<Source>(
  source: Source,
  groupIds: readonly BlockFormatGroupId[],
  builders: Record<BlockFormatGroupId, FormatBuilder<Source>>,
): BlockStylePresetFormat {
  return compactFormat(
    Object.assign({}, ...groupIds.map((groupId) => builders[groupId](source))),
  );
}

function compactFormat(value: BlockStylePresetFormat): BlockStylePresetFormat {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as BlockStylePresetFormat;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function rangedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function optionalString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, maximumLength);
  return normalized || undefined;
}

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function colorValue(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : fallback;
}

function optionalColor(value: unknown): string | undefined {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

function enumValue<T extends string>(
  value: unknown,
  choices: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && choices.includes(value as T)
    ? (value as T)
    : fallback;
}
