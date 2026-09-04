/* eslint-disable complexity, max-lines, max-lines-per-function -- versioned schemas, recipe constructors, migration, and validation form one compatibility boundary */
import { z } from "zod";
import type { BlockFormatGroupId } from "./blockFormat";
import type { BlockStylePresetFormat } from "./blockStylePresetFormat";
import {
  CONDITIONAL_BATCH_FIELD_IDS,
  CONDITIONAL_BATCH_OPERATORS,
  getConditionalBatchFieldDefinition,
  isConditionalBatchOperatorAllowed,
  type ConditionalBatchField,
  type ConditionalBatchOperator,
} from "./conditionalBatchFieldRegistry";
import type { ChapterSnapshot } from "./libraryTypes";
import type { TextStylePatch } from "./richTextMarkup";
import { TextEffectSchema } from "./textEffect";
import { TextGlowSchema } from "./textGlow";
import type { TranslationBlock } from "./textTypes";
import { formatConditionalBatchValidationIssue } from "./conditionalBatchErrorPresentation";
import {
  ConditionalReplacementV3Schema,
  ConditionalTextMatcherV3Schema,
  createConditionalLiteralMatcher,
  createConditionalLiteralReplacement,
  validateConditionalReplacementReferences,
  type ConditionalTextMatcherV3,
} from "./conditionalTextPattern";

export const CONDITIONAL_BATCH_SCHEMA_VERSION = 1 as const;
export const MAX_CONDITIONAL_BATCH_SCHEMES = 100;
export const MAX_CONDITIONAL_BATCH_CONDITIONS = 32;
export const MAX_CONDITIONAL_BATCH_ACTIONS = 64;
const MAX_CONDITIONAL_BATCH_SEQUENCES = 50;
export const MAX_CONDITIONAL_BATCH_FILE_BYTES = 2 * 1024 * 1024;
export const CONDITIONAL_BATCH_FILE_NAME = "batch-edit-schemes.yaml";
export const CONDITIONAL_BATCH_STARTER_SCHEME_IDS = [
  "starter-find-replace",
  "starter-ellipsis-spacing",
] as const;

const RuleIdSchema = z.string().trim().min(1).max(200);
const RuleNameSchema = z.string().trim().min(1).max(80);
const RuleDescriptionSchema = z.string().max(500);
const RuleNoteSchema = z.string().max(500).optional();
const TextValueSchema = z.string().max(20_000);
const NumberValueSchema = z.number().finite();
const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/iu);

const ConditionalBatchFieldSchema = z.enum(CONDITIONAL_BATCH_FIELD_IDS);
const ConditionalBatchOperatorSchema = z.enum(CONDITIONAL_BATCH_OPERATORS);

const ConditionalBatchConditionValueSchema = z.union([
  TextValueSchema,
  NumberValueSchema,
  z.boolean(),
  z.array(z.string().max(200)).min(1).max(64),
  z.null(),
]);

const ConditionalBatchConditionV2Schema = z
  .object({
    id: RuleIdSchema,
    enabled: z.boolean().default(true),
    note: RuleNoteSchema,
    field: ConditionalBatchFieldSchema,
    operator: ConditionalBatchOperatorSchema,
    value: ConditionalBatchConditionValueSchema.optional(),
    value2: NumberValueSchema.optional(),
    tolerance: z.number().finite().min(0).max(100).optional(),
    caseSensitive: z.boolean().optional(),
    multiline: z.boolean().optional(),
    dotAll: z.boolean().optional(),
    matcher: ConditionalTextMatcherV3Schema.optional(),
  })
  .strict()
  .superRefine(validateCondition);

export type ConditionalBatchConditionV2 = z.infer<
  typeof ConditionalBatchConditionV2Schema
>;

const ConditionalBatchConditionGroupV2Schema = z
  .object({
    id: RuleIdSchema,
    enabled: z.boolean().default(true),
    note: RuleNoteSchema,
    logic: z.enum(["all", "any"]),
    conditions: z
      .array(ConditionalBatchConditionV2Schema)
      .min(1)
      .max(MAX_CONDITIONAL_BATCH_CONDITIONS),
  })
  .strict();

export type ConditionalBatchConditionGroupV2 = z.infer<
  typeof ConditionalBatchConditionGroupV2Schema
>;

const ConditionalBatchMatchV2Schema = z
  .object({
    mode: z.enum(["all", "any", "allBlocks"]),
    conditions: z.array(ConditionalBatchConditionV2Schema).default([]),
    groups: z.array(ConditionalBatchConditionGroupV2Schema).default([]),
  })
  .strict()
  .superRefine((match, context) => {
    const count =
      match.conditions.length +
      match.groups.reduce((total, group) => total + group.conditions.length, 0);
    if (count > MAX_CONDITIONAL_BATCH_CONDITIONS) {
      context.addIssue({
        code: "custom",
        message: `조건은 최대 ${MAX_CONDITIONAL_BATCH_CONDITIONS}개까지 저장할 수 있습니다.`,
        path: ["conditions"],
      });
    }
    if (
      match.mode === "allBlocks" &&
      (match.conditions.length > 0 || match.groups.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "모든 말풍선에는 조건을 함께 저장할 수 없습니다.",
        path: ["conditions"],
      });
    }
    if (
      match.mode !== "allBlocks" &&
      match.conditions.length === 0 &&
      match.groups.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "대상 조건을 하나 이상 추가하거나 모든 말풍선을 선택하세요.",
        path: ["conditions"],
      });
    }
  });

export type ConditionalBatchMatchV2 = z.infer<
  typeof ConditionalBatchMatchV2Schema
>;

const ActionBaseSchema = {
  id: RuleIdSchema,
  enabled: z.boolean().default(true),
  note: RuleNoteSchema,
};

const ConditionalBatchReplaceTextActionV2Schema = z
  .object({
    ...ActionBaseSchema,
    type: z.literal("replaceText"),
    target: z.enum(["translatedText", "sourceText", "both"]),
    matcher: ConditionalTextMatcherV3Schema,
    replacement: ConditionalReplacementV3Schema,
    allOccurrences: z.boolean().default(true),
  })
  .strict()
  .superRefine((action, context) => {
    const issue = validateConditionalReplacementReferences(
      action.matcher,
      action.replacement,
    );
    if (issue) {
      context.addIssue({
        code: "custom",
        message: issue,
        path: ["replacement"],
      });
    }
  });

export type ConditionalBatchReplaceTextActionV2 = z.infer<
  typeof ConditionalBatchReplaceTextActionV2Schema
>;

const CONDITIONAL_BATCH_WRITABLE_FIELDS = [
  "sourceText",
  "translatedText",
  "fontFamily",
  "speakerId",
  "reviewNote",
  "textRole",
  "fontRole",
  "renderDirection",
  "textAlign",
  "wordBreak",
  "reviewStatus",
  "fontSizePx",
  "lineHeight",
  "letterSpacing",
  "fontWidthScale",
  "rotationDeg",
  "textOpacity",
  "outlineWidthPx",
  "outlineWidthScale",
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
  "outerOutlineWidthPx",
] as const;

export type ConditionalBatchWritableField =
  (typeof CONDITIONAL_BATCH_WRITABLE_FIELDS)[number];

const ConditionalBatchWritableFieldSchema = z.enum(
  CONDITIONAL_BATCH_WRITABLE_FIELDS,
);

const ConditionalBatchSetFieldChangeV2Schema = z
  .object({
    field: ConditionalBatchWritableFieldSchema,
    operation: z.enum(["set", "clear"]).default("set"),
    value: ConditionalBatchConditionValueSchema.optional(),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.operation === "set" && change.value === undefined) {
      context.addIssue({
        code: "custom",
        message: "설정할 값을 입력하세요.",
        path: ["value"],
      });
    }
    if (
      change.operation === "clear" &&
      isRequiredConditionalBatchWritableField(change.field)
    ) {
      context.addIssue({
        code: "custom",
        message: "필수 값은 초기화할 수 없습니다.",
        path: ["operation"],
      });
    }
    if (change.operation === "set") {
      validateWritableFieldValue(change.field, change.value, context);
    }
  });

export type ConditionalBatchSetFieldChangeV2 = z.infer<
  typeof ConditionalBatchSetFieldChangeV2Schema
>;

const ConditionalBatchSetFieldsActionV2Schema = z
  .object({
    ...ActionBaseSchema,
    type: z.literal("setFields"),
    changes: z
      .array(ConditionalBatchSetFieldChangeV2Schema)
      .min(1)
      .max(CONDITIONAL_BATCH_WRITABLE_FIELDS.length),
  })
  .strict()
  .superRefine((action, context) => {
    addDuplicateIdIssues(
      action.changes.map((change) => change.field),
      "설정 필드",
      context,
      ["changes"],
    );
  });

export type ConditionalBatchSetFieldsActionV2 = z.infer<
  typeof ConditionalBatchSetFieldsActionV2Schema
>;

const BlockFormatGroupIdSchema = z.enum([
  "font",
  "size",
  "align",
  "wordBreak",
  "direction",
  "emphasis",
  "lineSpacing",
  "letterSpacing",
  "fontWidth",
  "color",
  "outline",
  "effect",
  "transform",
]);

const BlockStylePresetFormatSchema = z
  .object({
    fontFamily: z.string().max(120).optional(),
    fontSizePx: z.number().finite().min(1).max(512).optional(),
    autoFitText: z.boolean().optional(),
    textAlign: z.enum(["left", "center", "right"]).optional(),
    wordBreak: z
      .enum([
        "normal",
        "break-word",
        "break-all",
        "keep-all",
        "keep-all-overflow",
      ])
      .optional(),
    renderDirection: z.enum(["horizontal", "vertical"]).optional(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strikethrough: z.boolean().optional(),
    emphasisMark: z.boolean().optional(),
    lineHeight: z.number().finite().min(0.1).max(10).optional(),
    letterSpacing: z.number().finite().min(-1).max(5).optional(),
    fontWidthScale: z.number().finite().min(0.1).max(5).optional(),
    textColor: HexColorSchema.optional(),
    textOpacity: z.number().finite().min(0).max(1).optional(),
    outlineColor: HexColorSchema.optional(),
    outlineWidthPx: z.number().finite().min(0).max(64).optional(),
    outlineWidthScale: z.number().finite().min(0).max(8).optional(),
    outerOutlineColor: HexColorSchema.optional(),
    outerOutlineWidthPx: z.number().finite().min(0).max(64).optional(),
    textBackgroundEnabled: z.boolean().optional(),
    textBackgroundColor: HexColorSchema.optional(),
    textEffect: TextEffectSchema.optional(),
    textGlow: TextGlowSchema.optional(),
    rotationDeg: z.number().finite().min(-180).max(180).optional(),
  })
  .strict();

const ConditionalBatchApplyStylePresetActionV2Schema = z
  .object({
    ...ActionBaseSchema,
    type: z.literal("applyStylePreset"),
    presetId: RuleIdSchema.optional(),
    presetName: RuleNameSchema,
    groupIds: z.array(BlockFormatGroupIdSchema).min(1).max(13),
    format: BlockStylePresetFormatSchema,
  })
  .strict();

export type ConditionalBatchApplyStylePresetActionV2 = Omit<
  z.infer<typeof ConditionalBatchApplyStylePresetActionV2Schema>,
  "groupIds" | "format"
> & {
  groupIds: BlockFormatGroupId[];
  format: BlockStylePresetFormat;
};

const TextStylePatchSchema = z
  .object({
    bold: z.boolean().nullable().optional(),
    italic: z.boolean().nullable().optional(),
    underline: z.boolean().nullable().optional(),
    strikethrough: z.boolean().nullable().optional(),
    emphasisMark: z.boolean().nullable().optional(),
    sizePx: z.number().finite().min(1).max(512).nullable().optional(),
    fontFamily: z.string().max(120).nullable().optional(),
    opacity: z.number().finite().min(0).max(1).nullable().optional(),
    widthScale: z.number().finite().min(0.1).max(5).nullable().optional(),
    color: HexColorSchema.nullable().optional(),
    backgroundColor: HexColorSchema.nullable().optional(),
    outlineColor: HexColorSchema.nullable().optional(),
    outlineWidthPx: z.number().finite().min(0).max(64).nullable().optional(),
    outerOutlineColor: HexColorSchema.nullable().optional(),
    outerOutlineWidthPx: z
      .number()
      .finite()
      .min(0)
      .max(64)
      .nullable()
      .optional(),
    glowColor: HexColorSchema.nullable().optional(),
    glowBlurPx: z.number().finite().min(0).max(64).nullable().optional(),
    glowOpacity: z.number().finite().min(0).max(1).nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "부분 서식을 하나 이상 선택하세요.",
  });

export const CONDITIONAL_BATCH_TEXT_STYLE_FIELDS = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "emphasisMark",
  "fontFamily",
  "sizePx",
  "opacity",
  "widthScale",
  "color",
  "backgroundColor",
  "outlineColor",
  "outlineWidthPx",
  "outerOutlineColor",
  "outerOutlineWidthPx",
  "glowColor",
  "glowBlurPx",
  "glowOpacity",
] as const;

const CONDITIONAL_BATCH_TEXT_STYLE_OPERATORS = [
  "equals",
  "notEquals",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "between",
] as const;

export type ConditionalBatchTextStyleField =
  (typeof CONDITIONAL_BATCH_TEXT_STYLE_FIELDS)[number];
export type ConditionalBatchTextStyleOperator =
  (typeof CONDITIONAL_BATCH_TEXT_STYLE_OPERATORS)[number];

const ConditionalBatchTextStyleMatchConditionSchema = z
  .object({
    id: RuleIdSchema,
    field: z.enum(CONDITIONAL_BATCH_TEXT_STYLE_FIELDS),
    operator: z.enum(CONDITIONAL_BATCH_TEXT_STYLE_OPERATORS),
    value: z.union([z.boolean(), z.string().max(120), z.number().finite()]),
    value2: z.number().finite().optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    const booleanField = [
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "emphasisMark",
    ].includes(condition.field);
    const colorField = [
      "color",
      "backgroundColor",
      "outlineColor",
      "outerOutlineColor",
      "glowColor",
    ].includes(condition.field);
    if (booleanField) {
      if (
        typeof condition.value !== "boolean" ||
        !["equals", "notEquals"].includes(condition.operator)
      ) {
        context.addIssue({
          code: "custom",
          message: "선택한 부분 서식에 맞는 값을 고르세요.",
        });
      }
      return;
    }
    if (colorField) {
      if (
        typeof condition.value !== "string" ||
        !HexColorSchema.safeParse(condition.value).success ||
        !["equals", "notEquals"].includes(condition.operator)
      ) {
        context.addIssue({
          code: "custom",
          message: "비교할 색상을 고르세요.",
        });
      }
      return;
    }
    if (condition.field === "fontFamily") {
      if (
        typeof condition.value !== "string" ||
        condition.value.length === 0 ||
        !["equals", "notEquals"].includes(condition.operator)
      ) {
        context.addIssue({
          code: "custom",
          message: "비교할 글꼴을 고르세요.",
        });
      }
      return;
    }
    if (typeof condition.value !== "number") {
      context.addIssue({
        code: "custom",
        message: "비교할 숫자를 입력하세요.",
      });
      return;
    }
    if (condition.operator === "between" && condition.value2 === undefined) {
      context.addIssue({
        code: "custom",
        message: "범위의 끝 값을 입력하세요.",
        path: ["value2"],
      });
    }
    const values = [condition.value, condition.value2].filter(
      (value): value is number => value !== undefined,
    );
    const range = TEXT_STYLE_NUMBER_RANGES[condition.field];
    const invalid =
      !range || values.some((value) => value < range[0] || value > range[1]);
    if (invalid) {
      context.addIssue({
        code: "custom",
        message: range
          ? `${range[0]} 이상 ${range[1]} 이하의 값을 입력하세요.`
          : "비교할 숫자를 입력하세요.",
      });
    }
  });

const TEXT_STYLE_NUMBER_RANGES: Partial<
  Record<ConditionalBatchTextStyleField, readonly [number, number]>
> = {
  sizePx: [1, 512],
  opacity: [0, 1],
  widthScale: [0.1, 5],
  outlineWidthPx: [0, 64],
  outerOutlineWidthPx: [0, 64],
  glowBlurPx: [0, 64],
  glowOpacity: [0, 1],
};

export type ConditionalBatchTextStyleMatchCondition = z.infer<
  typeof ConditionalBatchTextStyleMatchConditionSchema
>;

const ConditionalBatchTextStyleMatchSchema = z
  .object({
    logic: z.enum(["all", "any"]),
    conditions: z
      .array(ConditionalBatchTextStyleMatchConditionSchema)
      .min(1)
      .max(CONDITIONAL_BATCH_TEXT_STYLE_FIELDS.length),
  })
  .strict()
  .superRefine((match, context) => {
    addDuplicateIdIssues(
      match.conditions.map((condition) => condition.id),
      "부분 서식 조건",
      context,
      ["conditions"],
    );
    const fields = match.conditions.map((condition) => condition.field);
    addDuplicateIdIssues(fields, "부분 서식 필드", context, ["conditions"]);
  });

export type ConditionalBatchTextStyleMatch = z.infer<
  typeof ConditionalBatchTextStyleMatchSchema
>;

const ConditionalBatchStyleTextActionV2Schema = z
  .object({
    ...ActionBaseSchema,
    type: z.literal("styleText"),
    target: z.literal("translatedText").default("translatedText"),
    scope: z.enum(["allText", "pattern"]),
    matcher: ConditionalTextMatcherV3Schema.optional(),
    allOccurrences: z.boolean().default(true),
    styleMode: z.enum(["overwrite", "fillMissing", "replace"]),
    matchStyle: ConditionalBatchTextStyleMatchSchema.optional(),
    patch: TextStylePatchSchema,
  })
  .strict()
  .superRefine((action, context) => {
    if (action.scope === "pattern" && !action.matcher) {
      context.addIssue({
        code: "custom",
        message: "서식을 적용할 패턴을 만드세요.",
        path: ["matcher"],
      });
    }
  });

export type ConditionalBatchStyleTextActionV2 = Omit<
  z.infer<typeof ConditionalBatchStyleTextActionV2Schema>,
  "patch"
> & { patch: TextStylePatch };

const ConditionalBatchActionV2Schema = z.union([
  ConditionalBatchReplaceTextActionV2Schema,
  ConditionalBatchSetFieldsActionV2Schema,
  ConditionalBatchApplyStylePresetActionV2Schema,
  ConditionalBatchStyleTextActionV2Schema,
]);

export type ConditionalBatchActionV2 =
  | ConditionalBatchReplaceTextActionV2
  | ConditionalBatchSetFieldsActionV2
  | ConditionalBatchApplyStylePresetActionV2
  | ConditionalBatchStyleTextActionV2;

const ConditionalBatchSchemeShape = {
  name: RuleNameSchema,
  description: RuleDescriptionSchema.default(""),
  match: ConditionalBatchMatchV2Schema,
  actions: z
    .array(ConditionalBatchActionV2Schema)
    .max(MAX_CONDITIONAL_BATCH_ACTIONS),
};

export const ConditionalBatchSchemeDraftV2Schema = z
  .object(ConditionalBatchSchemeShape)
  .strict()
  .superRefine((scheme, context) => {
    addDuplicateIdIssues(
      collectSchemeItemIds(scheme),
      "조건 또는 작업",
      context,
    );
  });

export type ConditionalBatchSchemeDraftV2 = Omit<
  z.infer<typeof ConditionalBatchSchemeDraftV2Schema>,
  "actions"
> & { actions: ConditionalBatchActionV2[] };

const ConditionalBatchSchemeV2Schema = z
  .object({ id: RuleIdSchema, ...ConditionalBatchSchemeShape })
  .strict()
  .superRefine((scheme, context) => {
    addDuplicateIdIssues(
      collectSchemeItemIds(scheme),
      "조건 또는 작업",
      context,
    );
  });

export type ConditionalBatchSchemeV2 = ConditionalBatchSchemeDraftV2 & {
  id: string;
};

export const ConditionalBatchSequenceV2Schema = z
  .object({
    id: RuleIdSchema,
    name: RuleNameSchema,
    description: RuleDescriptionSchema.default(""),
    steps: z
      .array(
        z
          .object({
            id: RuleIdSchema,
            schemeId: RuleIdSchema,
            enabled: z.boolean().default(true),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((sequence, context) => {
    addDuplicateIdIssues(
      sequence.steps.map((step) => step.id),
      "연속 실행 단계",
      context,
      ["steps"],
    );
    if (!sequence.steps.some((step) => step.enabled)) {
      context.addIssue({
        code: "custom",
        message: "연속 실행에서 사용할 단계를 하나 이상 켜세요.",
        path: ["steps"],
      });
    }
  });

export type ConditionalBatchSequenceV2 = z.infer<
  typeof ConditionalBatchSequenceV2Schema
>;

export const ConditionalBatchSnapshotV2Schema = z
  .object({
    schemaVersion: z.literal(CONDITIONAL_BATCH_SCHEMA_VERSION),
    schemes: z
      .array(ConditionalBatchSchemeV2Schema)
      .max(MAX_CONDITIONAL_BATCH_SCHEMES),
    sequences: z
      .array(ConditionalBatchSequenceV2Schema)
      .max(MAX_CONDITIONAL_BATCH_SEQUENCES)
      .default([]),
  })
  .strict()
  .superRefine((snapshot, context) => {
    addDuplicateIdIssues(
      snapshot.schemes.map((scheme) => scheme.id),
      "규칙",
      context,
      ["schemes"],
    );
    addDuplicateIdIssues(
      snapshot.sequences.map((sequence) => sequence.id),
      "연속 실행",
      context,
      ["sequences"],
    );
    const schemeIds = new Set(snapshot.schemes.map((scheme) => scheme.id));
    snapshot.sequences.forEach((sequence, sequenceIndex) => {
      sequence.steps.forEach((step, stepIndex) => {
        if (!schemeIds.has(step.schemeId)) {
          context.addIssue({
            code: "custom",
            message: `연속 실행 규칙을 찾을 수 없습니다: ${step.schemeId}`,
            path: ["sequences", sequenceIndex, "steps", stepIndex, "schemeId"],
          });
        }
      });
    });
  });

export type ConditionalBatchSnapshotV2 = Omit<
  z.infer<typeof ConditionalBatchSnapshotV2Schema>,
  "schemes"
> & { schemes: ConditionalBatchSchemeV2[] };

export const SaveConditionalBatchSchemeInputSchema = z
  .object({
    id: RuleIdSchema.optional(),
    scheme: ConditionalBatchSchemeDraftV2Schema,
  })
  .strict();

export type SaveConditionalBatchSchemeInput = z.infer<
  typeof SaveConditionalBatchSchemeInputSchema
>;

export const ConditionalBatchSchemeIdSchema = RuleIdSchema;

export type ConditionalBatchScope =
  | { kind: "selection"; pageId: string; blockIds: string[] }
  | { kind: "page"; pageId: string }
  | { kind: "chapter" };

export type ConditionalBatchConditionEvaluation = {
  conditionId: string;
  field: ConditionalBatchField;
  actualValue: string;
  rawValue: string | number | boolean | undefined;
  matched: boolean;
  enabled: boolean;
};

export type ConditionalBatchActionTrace = {
  actionId: string;
  actionType: ConditionalBatchActionV2["type"];
  changedFields: ConditionalBatchWritableField[];
  stepId?: string;
  schemeId?: string;
  schemeName?: string;
};

export type ConditionalBatchTextValues = {
  sourceText: string;
  translatedText: string;
};

export type ConditionalBatchPreviewResult = {
  key: string;
  pageId: string;
  pageName: string;
  blockId: string;
  before: ConditionalBatchTextValues;
  after: ConditionalBatchTextValues;
  beforeBlock: TranslationBlock;
  afterBlock: TranslationBlock;
  changedFields: ConditionalBatchWritableField[];
  actionTargetFields: ConditionalBatchWritableField[];
  conditionEvaluations: ConditionalBatchConditionEvaluation[];
  actionTrace: ConditionalBatchActionTrace[];
  conflictFingerprint: string;
  sequenceTrace?: ConditionalBatchSequenceStepTrace[];
};

type ConditionalBatchSequenceStepTrace = {
  stepId: string;
  schemeId: string;
  schemeName: string;
  beforeBlock: TranslationBlock;
  afterBlock: TranslationBlock;
  changedFields: ConditionalBatchWritableField[];
  actionTargetFields: ConditionalBatchWritableField[];
  conditionEvaluations: ConditionalBatchConditionEvaluation[];
  actionTrace: ConditionalBatchActionTrace[];
  conflictFingerprint: string;
};

export type ConditionalBatchPreview = {
  chapterId: string;
  matchedCount: number;
  /** Stable keys for every condition match, including no-op action results. */
  matchedResultKeys: string[];
  unchangedMatchCount: number;
  inspectionOnly: boolean;
  results: ConditionalBatchPreviewResult[];
};

export type ConditionalBatchApplyResult = {
  chapter: ChapterSnapshot;
  appliedCount: number;
  conflictCount: number;
  dirtyPageIds: string[];
};

export type ConditionalBatchSequencePreview = {
  sequenceId: string;
  chapterId: string;
  scope: ConditionalBatchScope;
  steps: Array<{
    stepId: string;
    schemeId: string;
    preview: ConditionalBatchPreview;
  }>;
  preview: ConditionalBatchPreview;
  chapterAfter: ChapterSnapshot;
};

export function createEmptyConditionalBatchSnapshot(): ConditionalBatchSnapshotV2 {
  return {
    schemaVersion: CONDITIONAL_BATCH_SCHEMA_VERSION,
    schemes: [],
    sequences: [],
  };
}

/**
 * The two starter entries are real schemes, not recipe-only UI. Stable IDs let
 * local favourites point at them without leaking presentation state into YAML.
 */
export function createConditionalBatchStarterSchemes(): ConditionalBatchSchemeV2[] {
  return [
    {
      id: CONDITIONAL_BATCH_STARTER_SCHEME_IDS[0],
      ...createConditionalBatchRecipeDraft("findReplace", {
        find: "",
        idFactory: createStarterIdFactory("find-replace"),
      }),
    },
    {
      id: CONDITIONAL_BATCH_STARTER_SCHEME_IDS[1],
      ...createConditionalBatchRecipeDraft("ellipsis", {
        idFactory: createStarterIdFactory("ellipsis-spacing"),
      }),
    },
  ];
}

export function includeConditionalBatchStarterSchemes(
  snapshot: ConditionalBatchSnapshotV2,
): ConditionalBatchSnapshotV2 {
  const existingIds = new Set(snapshot.schemes.map((scheme) => scheme.id));
  const availableSlots = Math.max(
    0,
    MAX_CONDITIONAL_BATCH_SCHEMES - snapshot.schemes.length,
  );
  const missing = createConditionalBatchStarterSchemes()
    .filter((scheme) => !existingIds.has(scheme.id))
    .slice(0, availableSlots);
  if (missing.length === 0) return snapshot;
  return ConditionalBatchSnapshotV2Schema.parse({
    ...snapshot,
    schemes: [...missing, ...snapshot.schemes],
  });
}

function createStarterIdFactory(namespace: string): (prefix: string) => string {
  let sequence = 0;
  return (prefix) => `starter-${namespace}-${prefix}-${++sequence}`;
}

export function createEllipsisBatchSchemeDraft(
  idFactory: (prefix: string) => string = createConditionalBatchClientId,
): ConditionalBatchSchemeDraftV2 {
  return {
    name: "말줄임표·공백 정리",
    description: "",
    match: {
      mode: "allBlocks",
      conditions: [],
      groups: [],
    },
    actions: [
      {
        id: idFactory("action"),
        enabled: true,
        type: "replaceText",
        target: "translatedText",
        matcher: createConditionalLiteralMatcher("..."),
        replacement: createConditionalLiteralReplacement("…"),
        allOccurrences: true,
      },
      {
        id: idFactory("action"),
        enabled: true,
        type: "replaceText",
        target: "translatedText",
        matcher: createWhitespaceMatcher(idFactory),
        replacement: createConditionalLiteralReplacement(" "),
        allOccurrences: true,
      },
    ],
  };
}

export type ConditionalBatchRecipeId =
  | "findReplace"
  | "ellipsis"
  | "whitespace"
  | "emptyTranslation"
  | "verticalStyle"
  | "lowConfidence"
  | "sameAsSource"
  | "numberMismatch"
  | "unbalancedPunctuation"
  | "suspiciousWhitespace"
  | "glossaryMismatch"
  | "lengthExceeded"
  | "lowFontConfidence"
  | "needsReview"
  | "blank";

export function createConditionalBatchRecipeDraft(
  recipeId: ConditionalBatchRecipeId,
  options: {
    find?: string;
    replace?: string;
    stylePreset?: {
      id?: string;
      name: string;
      groupIds: BlockFormatGroupId[];
      format: BlockStylePresetFormat;
    };
    idFactory?: (prefix: string) => string;
  } = {},
): ConditionalBatchSchemeDraftV2 {
  const idFactory = options.idFactory ?? createConditionalBatchClientId;
  if (recipeId === "ellipsis") return createEllipsisBatchSchemeDraft(idFactory);
  if (recipeId === "emptyTranslation") {
    return createInspectionDraft(
      "빈 번역 찾기",
      "translatedText",
      "empty",
      idFactory,
    );
  }
  if (recipeId === "lowConfidence") {
    return createInspectionDraft(
      "낮은 인식 신뢰도 찾기",
      "confidence",
      "lessThan",
      idFactory,
      0.7,
    );
  }
  if (recipeId === "lowFontConfidence") {
    return createInspectionDraft(
      "낮은 글꼴 신뢰도 찾기",
      "fontRoleConfidence",
      "lessThan",
      idFactory,
      0.7,
    );
  }
  if (recipeId === "sameAsSource") {
    return createInspectionDraft(
      "원문과 같은 번역 찾기",
      "sameAsSource",
      "isTrue",
      idFactory,
    );
  }
  if (recipeId === "numberMismatch") {
    return createInspectionDraft(
      "숫자 불일치 찾기",
      "numberMismatch",
      "isTrue",
      idFactory,
    );
  }
  if (recipeId === "unbalancedPunctuation") {
    return createInspectionDraft(
      "괄호·따옴표 불균형 찾기",
      "unbalancedPunctuation",
      "isTrue",
      idFactory,
    );
  }
  if (recipeId === "suspiciousWhitespace") {
    return createInspectionDraft(
      "의심스러운 공백 찾기",
      "suspiciousWhitespace",
      "isTrue",
      idFactory,
    );
  }
  if (recipeId === "glossaryMismatch") {
    return createInspectionDraft(
      "용어집 표기 불일치 찾기",
      "glossaryMismatch",
      "isTrue",
      idFactory,
    );
  }
  if (recipeId === "lengthExceeded") {
    return createInspectionDraft(
      "긴 번역 찾기",
      "translatedLength",
      "greaterThan",
      idFactory,
      120,
    );
  }
  if (recipeId === "needsReview") {
    return createInspectionDraft(
      "검수 대기 찾기",
      "reviewStatus",
      "equals",
      idFactory,
      "needs_review",
    );
  }
  if (recipeId === "whitespace") {
    return {
      name: "공백 정리",
      description: "",
      match: {
        mode: "allBlocks",
        groups: [],
        conditions: [],
      },
      actions: [
        {
          id: idFactory("action"),
          enabled: true,
          type: "replaceText",
          target: "translatedText",
          matcher: createWhitespaceMatcher(idFactory),
          replacement: createConditionalLiteralReplacement(" "),
          allOccurrences: true,
        },
      ],
    };
  }
  if (recipeId === "verticalStyle" && options.stylePreset) {
    const preset = options.stylePreset;
    return {
      name: recipeId === "verticalStyle" ? "세로쓰기 서식" : "효과음 서식",
      description: "",
      match: {
        mode: "all",
        groups: [],
        conditions: [
          {
            id: idFactory("condition"),
            enabled: true,
            field:
              recipeId === "verticalStyle" ? "renderDirection" : "textRole",
            operator: "equals",
            value: recipeId === "verticalStyle" ? "vertical" : "sound",
          },
        ],
      },
      actions: [
        {
          id: idFactory("action"),
          enabled: true,
          type: "applyStylePreset",
          presetId: preset.id,
          presetName: preset.name,
          groupIds: preset.groupIds,
          format: preset.format,
        },
      ],
    };
  }
  if (recipeId === "blank") return createBlankBatchSchemeDraft(idFactory);
  const find = options.find ?? "";
  return {
    name: "찾아 바꾸기",
    description: "",
    match: {
      mode: "allBlocks",
      groups: [],
      conditions: [],
    },
    actions: [
      {
        id: idFactory("action"),
        enabled: true,
        type: "replaceText",
        target: "translatedText",
        matcher: createConditionalLiteralMatcher(find),
        replacement: createConditionalLiteralReplacement(options.replace ?? ""),
        allOccurrences: true,
      },
    ],
  };
}

export function createBlankBatchSchemeDraft(
  idFactory: (prefix: string) => string = createConditionalBatchClientId,
): ConditionalBatchSchemeDraftV2 {
  return {
    name: "새 규칙",
    description: "",
    match: {
      mode: "allBlocks",
      groups: [],
      conditions: [],
    },
    actions: [
      {
        id: idFactory("action"),
        enabled: true,
        type: "replaceText",
        target: "translatedText",
        matcher: createConditionalLiteralMatcher(""),
        replacement: createConditionalLiteralReplacement(""),
        allOccurrences: true,
      },
    ],
  };
}

export function createConditionalBatchClientId(prefix: string): string {
  const entropy = Math.random().toString(36).slice(2, 10);
  return prefix + "-" + Date.now().toString(36) + "-" + entropy;
}

export function parseConditionalBatchSnapshot(input: unknown): {
  snapshot: ConditionalBatchSnapshotV2;
} {
  const parsed = ConditionalBatchSnapshotV2Schema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      formatConditionalBatchValidationIssue(parsed.error.issues[0]) ??
        "일괄 편집 규칙을 확인하세요.",
    );
  }
  return { snapshot: parsed.data };
}

function validateCondition(
  condition: {
    field: ConditionalBatchField;
    operator: ConditionalBatchOperator;
    value?: string | number | boolean | string[] | null;
    value2?: number;
    tolerance?: number;
    matcher?: ConditionalTextMatcherV3;
  },
  context: z.RefinementCtx,
): void {
  if (!isConditionalBatchOperatorAllowed(condition.field, condition.operator)) {
    context.addIssue({
      code: "custom",
      message: "선택한 필드에서 사용할 수 없는 비교 방식입니다.",
      path: ["operator"],
    });
    return;
  }
  const definition = getConditionalBatchFieldDefinition(condition.field);
  const usesMatcher =
    condition.operator === "regex" || condition.operator === "notRegex";
  const noValue = ["empty", "notEmpty", "isTrue", "isFalse"].includes(
    condition.operator,
  );
  if (usesMatcher && !condition.matcher) {
    context.addIssue({
      code: "custom",
      message: "비교할 패턴을 만드세요.",
      path: ["matcher"],
    });
  }
  if (!noValue && !usesMatcher && condition.value === undefined) {
    context.addIssue({
      code: "custom",
      message: "비교할 값을 입력하세요.",
      path: ["value"],
    });
  }
  if (
    definition.kind === "number" &&
    !noValue &&
    typeof condition.value !== "number"
  ) {
    context.addIssue({
      code: "custom",
      message: "숫자를 입력하세요.",
      path: ["value"],
    });
  }
  if (
    (condition.operator === "oneOf" || condition.operator === "notOneOf") &&
    !Array.isArray(condition.value)
  ) {
    context.addIssue({
      code: "custom",
      message: "하나 이상의 값을 선택하세요.",
      path: ["value"],
    });
  }
  if (condition.operator === "between" && condition.value2 === undefined) {
    context.addIssue({
      code: "custom",
      message: "범위의 끝값을 입력하세요.",
      path: ["value2"],
    });
  }
  if (condition.operator === "near") {
    if (
      typeof condition.value !== "string" ||
      !HexColorSchema.safeParse(condition.value).success
    ) {
      context.addIssue({
        code: "custom",
        message: "색상을 선택하세요.",
        path: ["value"],
      });
    }
    if (condition.tolerance === undefined) {
      context.addIssue({
        code: "custom",
        message: "색상 허용 오차를 입력하세요.",
        path: ["tolerance"],
      });
    }
  }
}

export function isRequiredConditionalBatchWritableField(
  field: ConditionalBatchWritableField,
): boolean {
  return [
    "sourceText",
    "translatedText",
    "renderDirection",
    "textAlign",
    "fontSizePx",
    "lineHeight",
    "textColor",
  ].includes(field);
}

function validateWritableFieldValue(
  field: ConditionalBatchWritableField,
  value: string | number | boolean | string[] | null | undefined,
  context: z.RefinementCtx,
): void {
  const definition = getConditionalBatchFieldDefinition(field);
  const issue = (message: string): void => {
    context.addIssue({ code: "custom", message, path: ["value"] });
  };
  if (definition.kind === "boolean") {
    if (typeof value !== "boolean") issue("예 또는 아니오를 선택하세요.");
    return;
  }
  if (definition.kind === "number") {
    if (typeof value !== "number") {
      issue("숫자를 입력하세요.");
      return;
    }
    const range = definition.number;
    if (!range || value < range.min || value > range.max) {
      issue(
        range
          ? `${range.min} 이상 ${range.max} 이하의 숫자를 입력하세요.`
          : "숫자 값을 입력하세요.",
      );
    }
    return;
  }
  if (definition.kind === "color") {
    if (typeof value !== "string" || !HexColorSchema.safeParse(value).success) {
      issue("#RRGGBB 형식의 색상을 선택하세요.");
    }
    return;
  }
  if (typeof value !== "string") {
    issue("문자 값을 입력하세요.");
    return;
  }
  const allowed = WRITABLE_ENUM_VALUES[field];
  if (allowed && !allowed.includes(value)) {
    issue("지원하는 값 중 하나를 선택하세요.");
  }
}

const WRITABLE_ENUM_VALUES: Partial<
  Record<ConditionalBatchWritableField, readonly string[]>
> = {
  textRole: ["ordinary", "sound"],
  fontRole: [
    "dialogue",
    "narration",
    "thought",
    "whisper",
    "aside_balloon_edge",
    "emphasis_dialogue",
    "shout",
    "sfx_impact",
    "sfx_motion",
    "sfx_ambient",
    "sfx_emotion",
    "sfx_comic",
    "sign_ui_title",
    "other",
    "unknown_needs_review",
  ],
  renderDirection: ["horizontal", "vertical"],
  textAlign: ["left", "center", "right"],
  wordBreak: [
    "normal",
    "break-word",
    "break-all",
    "keep-all",
    "keep-all-overflow",
  ],
  reviewStatus: ["draft", "needs_review", "reviewed"],
};

function collectSchemeItemIds(
  scheme: Pick<ConditionalBatchSchemeDraftV2, "match" | "actions">,
): string[] {
  return [
    ...scheme.match.conditions.map((condition) => condition.id),
    ...scheme.match.groups.flatMap((group) => [
      group.id,
      ...group.conditions.map((condition) => condition.id),
    ]),
    ...scheme.actions.map((action) => action.id),
  ];
}

function createInspectionDraft(
  name: string,
  field: ConditionalBatchField,
  operator: ConditionalBatchOperator,
  idFactory: (prefix: string) => string,
  value?: string | number | boolean,
): ConditionalBatchSchemeDraftV2 {
  return {
    name,
    description: "",
    match: {
      mode: "all",
      groups: [],
      conditions: [
        {
          id: idFactory("condition"),
          enabled: true,
          field,
          operator,
          ...(value === undefined ? {} : { value }),
        },
      ],
    },
    actions: [],
  };
}

function createWhitespaceMatcher(
  idFactory: (prefix: string) => string,
): ConditionalTextMatcherV3 {
  return {
    mode: "visual",
    caseSensitive: true,
    nodes: [
      {
        id: idFactory("pattern"),
        kind: "character",
        character: "whitespace",
        repeat: { min: 2, max: null, greedy: true },
      },
    ],
  };
}

function addDuplicateIdIssues(
  ids: string[],
  label: string,
  context: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (seen.has(id)) {
      context.addIssue({
        code: "custom",
        message: label + " ID가 중복되었습니다: " + id,
        path: [...path, index],
      });
    }
    seen.add(id);
  }
}
