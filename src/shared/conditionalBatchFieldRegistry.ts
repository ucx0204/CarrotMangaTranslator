/* eslint-disable complexity, max-lines, max-lines-per-function -- field metadata and exhaustive typed readers stay co-located as the single registry contract */
import { parseRichText, stripRichTextMarkup } from "./richTextMarkup";
import type { MangaPage } from "./libraryTypes";
import type { TranslationBlock } from "./textTypes";
import type { GlossaryEntry } from "./workContextTypes";

export const CONDITIONAL_BATCH_FIELD_IDS = [
  "sourceText",
  "translatedText",
  "fontFamily",
  "speakerId",
  "reviewNote",
  "textRole",
  "fontRole",
  "sourceDirection",
  "renderDirection",
  "textAlign",
  "wordBreak",
  "reviewStatus",
  "confidence",
  "fontRoleConfidence",
  "fontSizePx",
  "lineHeight",
  "letterSpacing",
  "fontWidthScale",
  "rotationDeg",
  "textOpacity",
  "outlineWidthPx",
  "outlineWidthScale",
  "outerOutlineWidthPx",
  "pageIndex",
  "blockIndex",
  "lineCount",
  "sourceLength",
  "translatedLength",
  "bboxWidth",
  "bboxHeight",
  "bboxAspectRatio",
  "textColor",
  "outlineColor",
  "outerOutlineColor",
  "textBackgroundColor",
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "emphasisMark",
  "textBackgroundEnabled",
  "autoFitText",
  "inpaintExcluded",
  "hasInlineStyle",
  "hasSpeaker",
  "hasGlossary",
  "textEffectEnabled",
  "textEffectColor",
  "textEffectOffsetX",
  "textEffectOffsetY",
  "textEffectBlur",
  "textEffectOpacity",
  "textGlowEnabled",
  "textGlowColor",
  "textGlowBlur",
  "textGlowOpacity",
  "sameAsSource",
  "numberMismatch",
  "unbalancedPunctuation",
  "suspiciousWhitespace",
  "glossaryMismatch",
] as const;

export type ConditionalBatchField =
  (typeof CONDITIONAL_BATCH_FIELD_IDS)[number];

type ConditionalBatchFieldKind =
  | "text"
  | "enum"
  | "number"
  | "color"
  | "boolean";

type ConditionalBatchFieldCategory =
  | "text"
  | "layout"
  | "typography"
  | "review"
  | "derived"
  | "inspection";

export const CONDITIONAL_BATCH_OPERATORS = [
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
  "regex",
  "notRegex",
  "empty",
  "notEmpty",
  "oneOf",
  "notOneOf",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "between",
  "near",
  "isTrue",
  "isFalse",
] as const;

export type ConditionalBatchOperator =
  (typeof CONDITIONAL_BATCH_OPERATORS)[number];

const TEXT_OPERATORS: readonly ConditionalBatchOperator[] = [
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
  "regex",
  "notRegex",
  "empty",
  "notEmpty",
];
const ENUM_OPERATORS: readonly ConditionalBatchOperator[] = [
  "equals",
  "notEquals",
  "oneOf",
  "notOneOf",
  "empty",
  "notEmpty",
];
const NUMBER_OPERATORS: readonly ConditionalBatchOperator[] = [
  "equals",
  "notEquals",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "between",
];
const COLOR_OPERATORS: readonly ConditionalBatchOperator[] = [
  "equals",
  "notEquals",
  "near",
  "empty",
  "notEmpty",
];
const BOOLEAN_OPERATORS: readonly ConditionalBatchOperator[] = [
  "isTrue",
  "isFalse",
];

export type ConditionalBatchFieldDefinition = {
  id: ConditionalBatchField;
  kind: ConditionalBatchFieldKind;
  category: ConditionalBatchFieldCategory;
  operators: readonly ConditionalBatchOperator[];
  writable: boolean;
  quick: boolean;
};

function field(
  id: ConditionalBatchField,
  kind: ConditionalBatchFieldKind,
  category: ConditionalBatchFieldCategory,
  options: { writable?: boolean; quick?: boolean } = {},
): ConditionalBatchFieldDefinition {
  return {
    id,
    kind,
    category,
    operators:
      kind === "text"
        ? TEXT_OPERATORS
        : kind === "enum"
          ? ENUM_OPERATORS
          : kind === "number"
            ? NUMBER_OPERATORS
            : kind === "color"
              ? COLOR_OPERATORS
              : BOOLEAN_OPERATORS,
    writable: options.writable ?? false,
    quick: options.quick ?? false,
  };
}

export const CONDITIONAL_BATCH_FIELD_DEFINITIONS: readonly ConditionalBatchFieldDefinition[] =
  [
    field("sourceText", "text", "text", { writable: true, quick: true }),
    field("translatedText", "text", "text", { writable: true, quick: true }),
    field("fontFamily", "text", "typography", { writable: true }),
    field("speakerId", "text", "review", { writable: true }),
    field("reviewNote", "text", "review", { writable: true }),
    field("textRole", "enum", "text", { writable: true, quick: true }),
    field("fontRole", "enum", "typography", { writable: true }),
    field("sourceDirection", "enum", "layout", { quick: true }),
    field("renderDirection", "enum", "layout", {
      writable: true,
      quick: true,
    }),
    field("textAlign", "enum", "layout", { writable: true }),
    field("wordBreak", "enum", "layout", { writable: true }),
    field("reviewStatus", "enum", "review", { writable: true, quick: true }),
    field("confidence", "number", "review"),
    field("fontRoleConfidence", "number", "review"),
    field("fontSizePx", "number", "typography", { writable: true }),
    field("lineHeight", "number", "typography", { writable: true }),
    field("letterSpacing", "number", "typography", { writable: true }),
    field("fontWidthScale", "number", "typography", { writable: true }),
    field("rotationDeg", "number", "layout", { writable: true }),
    field("textOpacity", "number", "typography", { writable: true }),
    field("outlineWidthPx", "number", "typography", { writable: true }),
    field("outlineWidthScale", "number", "typography", { writable: true }),
    field("outerOutlineWidthPx", "number", "typography", {
      writable: true,
    }),
    field("pageIndex", "number", "derived"),
    field("blockIndex", "number", "derived"),
    field("lineCount", "number", "derived"),
    field("sourceLength", "number", "derived"),
    field("translatedLength", "number", "derived"),
    field("bboxWidth", "number", "derived"),
    field("bboxHeight", "number", "derived"),
    field("bboxAspectRatio", "number", "derived"),
    field("textColor", "color", "typography", { writable: true }),
    field("outlineColor", "color", "typography", { writable: true }),
    field("outerOutlineColor", "color", "typography", { writable: true }),
    field("textBackgroundColor", "color", "typography", {
      writable: true,
    }),
    field("bold", "boolean", "typography", { writable: true }),
    field("italic", "boolean", "typography", { writable: true }),
    field("underline", "boolean", "typography", { writable: true }),
    field("strikethrough", "boolean", "typography", { writable: true }),
    field("emphasisMark", "boolean", "typography", { writable: true }),
    field("textBackgroundEnabled", "boolean", "typography", {
      writable: true,
    }),
    field("autoFitText", "boolean", "typography", { writable: true }),
    field("inpaintExcluded", "boolean", "review", { writable: true }),
    field("hasInlineStyle", "boolean", "inspection"),
    field("hasSpeaker", "boolean", "inspection"),
    field("hasGlossary", "boolean", "inspection"),
    field("textEffectEnabled", "boolean", "typography", { writable: true }),
    field("textEffectColor", "color", "typography", { writable: true }),
    field("textEffectOffsetX", "number", "typography", { writable: true }),
    field("textEffectOffsetY", "number", "typography", { writable: true }),
    field("textEffectBlur", "number", "typography", { writable: true }),
    field("textEffectOpacity", "number", "typography", { writable: true }),
    field("textGlowEnabled", "boolean", "typography", { writable: true }),
    field("textGlowColor", "color", "typography", { writable: true }),
    field("textGlowBlur", "number", "typography", { writable: true }),
    field("textGlowOpacity", "number", "typography", { writable: true }),
    field("sameAsSource", "boolean", "inspection"),
    field("numberMismatch", "boolean", "inspection"),
    field("unbalancedPunctuation", "boolean", "inspection"),
    field("suspiciousWhitespace", "boolean", "inspection"),
    field("glossaryMismatch", "boolean", "inspection"),
  ];

const FIELD_DEFINITION_BY_ID = new Map(
  CONDITIONAL_BATCH_FIELD_DEFINITIONS.map((definition) => [
    definition.id,
    definition,
  ]),
);

export type ConditionalBatchFieldReadContext = {
  page: MangaPage;
  pageIndex: number;
  blockIndex: number;
  glossary?: readonly GlossaryEntry[];
};

export function getConditionalBatchFieldDefinition(
  fieldId: ConditionalBatchField,
): ConditionalBatchFieldDefinition {
  const definition = FIELD_DEFINITION_BY_ID.get(fieldId);
  if (!definition) throw new Error(`알 수 없는 일관 편집 필드: ${fieldId}`);
  return definition;
}

export function isConditionalBatchOperatorAllowed(
  fieldId: ConditionalBatchField,
  operator: ConditionalBatchOperator,
): boolean {
  return getConditionalBatchFieldDefinition(fieldId).operators.includes(
    operator,
  );
}

export function readConditionalBatchField(
  block: TranslationBlock,
  fieldId: ConditionalBatchField,
  context: ConditionalBatchFieldReadContext,
): string | number | boolean | undefined {
  switch (fieldId) {
    case "sourceText":
      return block.sourceText;
    case "translatedText":
      return stripRichTextMarkup(block.translatedText);
    case "fontFamily":
    case "speakerId":
    case "reviewNote":
    case "textRole":
    case "fontRole":
    case "sourceDirection":
    case "renderDirection":
    case "textAlign":
    case "wordBreak":
    case "reviewStatus":
    case "confidence":
    case "fontRoleConfidence":
    case "fontSizePx":
    case "lineHeight":
    case "letterSpacing":
    case "fontWidthScale":
    case "rotationDeg":
    case "textOpacity":
    case "outlineWidthPx":
    case "outlineWidthScale":
    case "outerOutlineWidthPx":
    case "textColor":
    case "outlineColor":
    case "outerOutlineColor":
    case "textBackgroundColor":
    case "bold":
    case "italic":
    case "underline":
    case "strikethrough":
    case "emphasisMark":
    case "textBackgroundEnabled":
    case "autoFitText":
    case "inpaintExcluded":
      return block[fieldId];
    case "pageIndex":
      return context.pageIndex + 1;
    case "blockIndex":
      return context.blockIndex + 1;
    case "lineCount":
      return countVisibleLines(block.translatedText);
    case "sourceLength":
      return countVisibleCharacters(block.sourceText);
    case "translatedLength":
      return countVisibleCharacters(stripRichTextMarkup(block.translatedText));
    case "bboxWidth":
      return normalizeBboxDimension(
        block.bbox.w,
        block.bboxSpace,
        context.page.width,
      );
    case "bboxHeight":
      return normalizeBboxDimension(
        block.bbox.h,
        block.bboxSpace,
        context.page.height,
      );
    case "bboxAspectRatio":
      return block.bbox.h === 0 ? 0 : block.bbox.w / block.bbox.h;
    case "hasInlineStyle":
      return hasInlineStyle(block);
    case "hasSpeaker":
      return Boolean(block.speakerId?.trim());
    case "hasGlossary":
      return Boolean(block.glossaryEntryIds?.length);
    case "textEffectEnabled":
      return Boolean(block.textEffect?.enabled);
    case "textEffectColor":
      return block.textEffect?.color;
    case "textEffectOffsetX":
      return block.textEffect?.offsetXpx;
    case "textEffectOffsetY":
      return block.textEffect?.offsetYpx;
    case "textEffectBlur":
      return block.textEffect?.blurPx;
    case "textEffectOpacity":
      return block.textEffect?.opacity;
    case "textGlowEnabled":
      return Boolean(block.textGlow?.enabled);
    case "textGlowColor":
      return block.textGlow?.color;
    case "textGlowBlur":
      return block.textGlow?.blurPx;
    case "textGlowOpacity":
      return block.textGlow?.opacity;
    case "sameAsSource":
      return textsAreSame(block);
    case "numberMismatch":
      return numbersDiffer(block);
    case "unbalancedPunctuation":
      return hasUnbalancedPunctuation(
        stripRichTextMarkup(block.translatedText),
      );
    case "suspiciousWhitespace":
      return hasSuspiciousWhitespace(stripRichTextMarkup(block.translatedText));
    case "glossaryMismatch":
      return hasGlossaryMismatch(block, context.glossary ?? []);
  }
}

export function formatConditionalBatchFieldValue(
  value: string | number | boolean | undefined,
): string {
  if (value === undefined || value === "") return "∅";
  if (typeof value === "boolean") return value ? "예" : "아니오";
  if (typeof value === "number") return Number(value.toFixed(4)).toString();
  return value;
}

function normalizeBboxDimension(
  value: number,
  space: TranslationBlock["bboxSpace"],
  pageDimension: number,
): number {
  const denominator = space === "pixels" ? pageDimension : 1_000;
  return denominator <= 0 ? 0 : value / denominator;
}

function countVisibleLines(value: string): number {
  const visible = stripRichTextMarkup(value);
  return visible.length === 0 ? 0 : visible.split(/\r\n?|\n/u).length;
}

function countVisibleCharacters(value: string): number {
  return Array.from(value).length;
}

function hasInlineStyle(block: TranslationBlock): boolean {
  return parseRichText(
    block.translatedText,
    block.bold,
    block.italic,
  ).runs.some(
    (run) =>
      run.bold !== Boolean(block.bold) ||
      run.italic !== Boolean(block.italic) ||
      run.underline !== Boolean(block.underline) ||
      run.strikethrough !== Boolean(block.strikethrough) ||
      run.emphasisMark !== Boolean(block.emphasisMark) ||
      run.sizePx !== undefined ||
      run.fontFamily !== undefined ||
      run.opacity !== undefined ||
      run.widthScale !== undefined ||
      run.color !== undefined ||
      run.backgroundColor !== undefined ||
      run.outlineColor !== undefined ||
      run.outlineWidthPx !== undefined ||
      run.outerOutlineColor !== undefined ||
      run.outerOutlineWidthPx !== undefined ||
      run.glowColor !== undefined ||
      run.glowBlurPx !== undefined ||
      run.glowOpacity !== undefined ||
      Boolean(run.verticalCombine),
  );
}

function textsAreSame(block: TranslationBlock): boolean {
  const source = block.sourceText.trim();
  const translated = stripRichTextMarkup(block.translatedText).trim();
  return source.length > 0 && source === translated;
}

function numbersDiffer(block: TranslationBlock): boolean {
  const source = collectNumbers(block.sourceText);
  const translated = collectNumbers(stripRichTextMarkup(block.translatedText));
  return (
    source.length > 0 &&
    (source.length !== translated.length ||
      source.some((value, index) => value !== translated[index]))
  );
}

function collectNumbers(value: string): string[] {
  return (value.match(/[\p{N}]+(?:[.,][\p{N}]+)*/gu) ?? []).map((number) =>
    number.replace(/,/gu, ""),
  );
}

function hasUnbalancedPunctuation(value: string): boolean {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ["（", "）"],
    ["［", "］"],
    ["｛", "｝"],
    ["「", "」"],
    ["『", "』"],
    ["〈", "〉"],
    ["《", "》"],
  ];
  if (
    pairs.some(([open, close]) => count(value, open) !== count(value, close))
  ) {
    return true;
  }
  if (count(value, '"') % 2 !== 0 || count(value, "'") % 2 !== 0) {
    return true;
  }
  return (
    count(value, "“") !== count(value, "”") ||
    count(value, "‘") !== count(value, "’")
  );
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function hasSuspiciousWhitespace(value: string): boolean {
  return value !== value.trim() || /[ \u3000]{2,}|\t/u.test(value);
}

function hasGlossaryMismatch(
  block: TranslationBlock,
  glossary: readonly GlossaryEntry[],
): boolean {
  if (glossary.length === 0) return false;
  const translated = stripRichTextMarkup(block.translatedText);
  return glossary.some((entry) => {
    if (!entry.enabled || !entry.target.trim()) return false;
    const sources = [entry.source, ...(entry.aliases ?? [])].filter(Boolean);
    return (
      sources.some((source) => block.sourceText.includes(source)) &&
      !translated.includes(entry.target)
    );
  });
}
