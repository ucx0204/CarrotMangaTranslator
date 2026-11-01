import { CONDITIONAL_BATCH_FIELD_LABELS } from "./conditionalBatchLabels";
import {
  CONDITIONAL_BATCH_FIELD_DEFINITIONS,
  type ConditionalBatchField,
} from "../../../shared/conditionalBatchFieldRegistry";

import { TEXT_WORD_BREAK_VALUES } from "../../../shared/textWrapping";

import { appI18n } from "../appI18n";

const t = appI18n.getFixedT(null, "components");

const CONDITIONAL_BATCH_FIELD_GROUPS: ReadonlyArray<{
  label: string;
  fields: readonly ConditionalBatchField[];
}> = [
  {
    get label() {
      return t("batchEditorCopy.textAndDialogue");
    },
    fields: [
      "translatedText",
      "sourceText",
      "textRole",
      "speakerId",
      "hasSpeaker",
      "hasGlossary",
    ],
  },
  {
    get label() {
      return t("batchEditorCopy.fontAndTextAppearance");
    },
    fields: [
      "fontFamily",
      "fontRole",
      "fontSizePx",
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "emphasisMark",
      "textColor",
      "textBackgroundEnabled",
      "textBackgroundColor",
      "textOpacity",
      "lineHeight",
      "letterSpacing",
      "fontWidthScale",
      "outlineColor",
      "outlineWidthPx",
      "outlineWidthScale",
      "outerOutlineColor",
      "outerOutlineWidthPx",
      "autoFitText",
      "hasInlineStyle",
    ],
  },
  {
    get label() {
      return t("batchEditorCopy.directionAndLayout");
    },
    fields: [
      "renderDirection",
      "sourceDirection",
      "textAlign",
      "wordBreak",
      "rotationDeg",
    ],
  },
  {
    get label() {
      return t("batchEditorCopy.reviewAndRecognition");
    },
    fields: [
      "reviewStatus",
      "reviewNote",
      "confidence",
      "fontRoleConfidence",
      "inpaintExcluded",
    ],
  },
  {
    get label() {
      return t("batchEditorCopy.automaticChecks");
    },
    fields: [
      "sameAsSource",
      "numberMismatch",
      "unbalancedPunctuation",
      "suspiciousWhitespace",
      "glossaryMismatch",
    ],
  },
  {
    get label() {
      return t("batchEditorCopy.positionAndLength");
    },
    fields: [
      "pageIndex",
      "blockIndex",
      "lineCount",
      "translatedLength",
      "sourceLength",
      "bboxWidth",
      "bboxHeight",
      "bboxAspectRatio",
    ],
  },
  {
    get label() {
      return t("batchEditorCopy.advancedTextEffects");
    },
    fields: [
      "textEffectEnabled",
      "textEffectColor",
      "textEffectOpacity",
      "textEffectOffsetX",
      "textEffectOffsetY",
      "textEffectBlur",
      "textGlowEnabled",
      "textGlowColor",
      "textGlowOpacity",
      "textGlowBlur",
    ],
  },
];

const CONDITIONAL_BATCH_FIELD_GROUP_BY_ID = new Map(
  CONDITIONAL_BATCH_FIELD_GROUPS.flatMap((group) =>
    group.fields.map((field) => [field, group] as const),
  ),
);

const CONDITIONAL_BATCH_FIELD_ORDER = new Map(
  CONDITIONAL_BATCH_FIELD_GROUPS.flatMap((group) => group.fields).map(
    (field, index) => [field, index] as const,
  ),
);

const CONDITIONAL_BATCH_FIELDS_FOR_UI = [...CONDITIONAL_BATCH_FIELD_DEFINITIONS]
  .sort(
    (left, right) =>
      (CONDITIONAL_BATCH_FIELD_ORDER.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (CONDITIONAL_BATCH_FIELD_ORDER.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  )
  .map((definition) => ({
    ...definition,
    get label() {
      return CONDITIONAL_BATCH_FIELD_LABELS[definition.id];
    },
    get categoryLabel() {
      return (
        CONDITIONAL_BATCH_FIELD_GROUP_BY_ID.get(definition.id)?.label ??
        t("styleGuide.glossary.categories.other")
      );
    },
  }));

export const QUICK_CONDITIONAL_BATCH_FIELDS: readonly ConditionalBatchField[] =
  [
    "translatedText",
    "sourceText",
    "textRole",
    "fontFamily",
    "renderDirection",
    "reviewStatus",
  ];

export function listConditionalBatchFields() {
  return CONDITIONAL_BATCH_FIELDS_FOR_UI;
}

const HIDDEN_NEW_CONDITION_FIELDS = new Set<ConditionalBatchField>([
  "outlineWidthScale",
  "pageIndex",
  "blockIndex",
  "bboxWidth",
  "bboxHeight",
  "bboxAspectRatio",
  "textEffectColor",
  "textEffectOffsetX",
  "textEffectOffsetY",
  "textEffectBlur",
  "textEffectOpacity",
  "textGlowColor",
  "textGlowBlur",
  "textGlowOpacity",
]);

/**
 * Keep low-level fields readable for imported rules, but do not offer them
 * when creating a new condition. Exact shadow/glow components are useful as
 * values to set, not as everyday matching criteria; their on/off fields remain
 * available. Raw page/block indices and bounding-box geometry are brittle
 * implementation coordinates rather than useful everyday manga-editing
 * choices. outlineWidthScale is an internal multiplier duplicated by the
 * user-facing pixel thickness.
 */
export function isNewConditionalBatchConditionField(
  field: ConditionalBatchField,
): boolean {
  return !HIDDEN_NEW_CONDITION_FIELDS.has(field);
}

export function isNewConditionalBatchWritableField(
  field: ConditionalBatchField,
): boolean {
  return field !== "outlineWidthScale";
}

export function conditionalBatchEnumOptions(
  field: ConditionalBatchField,
): Array<{ value: string; label: string }> {
  switch (field) {
    case "textRole":
      return [
        {
          value: "ordinary",
          label: t("batchEditorCopy.normalDialogue"),
        },
        {
          value: "sound",
          label: t("styleGuide.glossary.categories.sfx"),
        },
      ];
    case "fontRole":
      return fontRoleOptions();
    case "sourceDirection":
    case "renderDirection":
      return [
        {
          value: "horizontal",
          label: t("batchEditorCopy.horizontalText"),
        },
        {
          value: "vertical",
          label: t("batchEditorCopy.verticalText"),
        },
      ];
    case "textAlign":
      return [
        {
          value: "left",
          label: t("regionOptions.boxx"),
        },
        {
          value: "center",
          label: t("transform.curve.align.center"),
        },
        {
          value: "right",
          label: t("batchEditorCopy.right"),
        },
      ];
    case "wordBreak":
      return TEXT_WORD_BREAK_VALUES.map((value) => ({
        value,
        label: t(`format.wordBreak.options.${value}`),
      }));
    case "reviewStatus":
      return [
        {
          value: "draft",
          label: t("batchEditorCopy.draft"),
        },
        {
          value: "needs_review",
          label: t("batchEditorCopy.needsReview"),
        },
        {
          value: "reviewed",
          label: t("batchEditorCopy.reviewed"),
        },
      ];
    default:
      return [];
  }
}

function fontRoleOptions() {
  return [
    ["dialogue", t("batchEditorCopy.dialogue")],
    ["narration", t("batchEditorCopy.narration")],
    ["thought", t("batchEditorCopy.thought")],
    ["whisper", t("batchEditorCopy.whisper")],
    ["aside_balloon_edge", t("batchEditorCopy.balloonEdge")],
    ["emphasis_dialogue", t("batchEditorCopy.emphasizedDialogue")],
    ["shout", t("batchEditorCopy.shout")],
    ["sfx_impact", t("batchEditorCopy.impactSoundEffect")],
    ["sfx_motion", t("batchEditorCopy.motionSoundEffect")],
    ["sfx_ambient", t("batchEditorCopy.ambientSoundEffect")],
    ["sfx_emotion", t("batchEditorCopy.emotionalSoundEffect")],
    ["sfx_comic", t("batchEditorCopy.comicSoundEffect")],
    ["sign_ui_title", t("batchEditorCopy.signsUiAndTitles")],
    ["other", t("styleGuide.glossary.categories.other")],
    ["unknown_needs_review", t("batchEditorCopy.unclassifiedNeedsReview")],
  ].map(([value, label]) => ({ value, label }));
}
