import type {
  ConditionalBatchField,
  ConditionalBatchOperator,
} from "../../../shared/conditionalBatchFieldRegistry";
import { appI18n } from "../appI18n";

const t = appI18n.getFixedT(null, "components");
export const CONDITIONAL_BATCH_FIELD_LABELS: Record<
  ConditionalBatchField,
  string
> = {
  get sourceText() {
    return t("conditionalBatch.when.sourceText");
  },
  get translatedText() {
    return t("conditionalBatch.when.translatedText");
  },
  get fontFamily() {
    return t("formatBatch.groups.font");
  },
  get speakerId() {
    return t("batchEditorCopy.speaker");
  },
  get reviewNote() {
    return t("batchEditorCopy.reviewNote");
  },
  get textRole() {
    return t("batchEditorCopy.textRole");
  },
  get fontRole() {
    return t("batchEditorCopy.fontRole");
  },
  get sourceDirection() {
    return t("batchEditorCopy.sourceDirection");
  },
  get renderDirection() {
    return t("batchEditorCopy.outputDirection");
  },
  get textAlign() {
    return t("batchEditorCopy.alignment");
  },
  get wordBreak() {
    return t("formatBatch.groups.wordBreak");
  },
  get reviewStatus() {
    return t("batchEditorCopy.reviewStatus");
  },
  get confidence() {
    return t("batchEditorCopy.ocrConfidence");
  },
  get fontRoleConfidence() {
    return t("batchEditorCopy.fontConfidence");
  },
  get fontSizePx() {
    return t("format.fontSize");
  },
  get lineHeight() {
    return t("format.lineHeight");
  },
  get letterSpacing() {
    return t("format.letterSpacing");
  },
  get fontWidthScale() {
    return t("format.fontWidth");
  },
  get rotationDeg() {
    return t("format.rotation");
  },
  get textOpacity() {
    return t("batchEditorCopy.textOpacity");
  },
  get outlineWidthPx() {
    return t("settings.format.color.outlineWidth");
  },
  get outlineWidthScale() {
    return t("batchEditorCopy.outlineScale");
  },
  get outerOutlineWidthPx() {
    return t("format.outerOutline.width");
  },
  get pageIndex() {
    return t("batchEditorCopy.pageIndex");
  },
  get blockIndex() {
    return t("batchEditorCopy.balloonIndex");
  },
  get lineCount() {
    return t("batchEditorCopy.lineCount");
  },
  get sourceLength() {
    return t("batchEditorCopy.sourceCharacterCount");
  },
  get translatedLength() {
    return t("batchEditorCopy.translationCharacterCount");
  },
  get bboxWidth() {
    return t("batchEditorCopy.balloonWidth");
  },
  get bboxHeight() {
    return t("batchEditorCopy.balloonHeight");
  },
  get bboxAspectRatio() {
    return t("batchEditorCopy.balloonAspectRatio");
  },
  get textColor() {
    return t("format.textColor");
  },
  get outlineColor() {
    return t("batchEditorCopy.outlineColor");
  },
  get outerOutlineColor() {
    return t("batchEditorCopy.outerOutlineColor");
  },
  get textBackgroundColor() {
    return t("batchEditorCopy.textAreaBackgroundColor");
  },
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
  get textBackgroundEnabled() {
    return t("format.textBackground.enabled");
  },
  get autoFitText() {
    return t("gatherText.autoFitLabel");
  },
  get inpaintExcluded() {
    return t("batchEditorCopy.excludedFromInpainting");
  },
  get hasInlineStyle() {
    return t("batchEditorCopy.hasInlineFormatting");
  },
  get hasSpeaker() {
    return t("batchEditorCopy.hasSpeaker");
  },
  get hasGlossary() {
    return t("batchEditorCopy.hasGlossaryLink");
  },
  get textEffectEnabled() {
    return t("format.textEffect.enabled");
  },
  get textEffectColor() {
    return t("batchEditorCopy.shadowColor");
  },
  get textEffectOffsetX() {
    return t("batchEditorCopy.shadowHorizontalOffset");
  },
  get textEffectOffsetY() {
    return t("batchEditorCopy.shadowVerticalOffset");
  },
  get textEffectBlur() {
    return t("batchEditorCopy.shadowBlur");
  },
  get textEffectOpacity() {
    return t("batchEditorCopy.shadowOpacity");
  },
  get textGlowEnabled() {
    return t("format.textGlow.enabled");
  },
  get textGlowColor() {
    return t("batchEditorCopy.glowColor");
  },
  get textGlowBlur() {
    return t("batchEditorCopy.glowSpread");
  },
  get textGlowOpacity() {
    return t("batchEditorCopy.glowOpacity");
  },
  get sameAsSource() {
    return t("batchEditorCopy.sameAsSource");
  },
  get numberMismatch() {
    return t("batchEditorCopy.numberMismatch");
  },
  get unbalancedPunctuation() {
    return t("batchEditorCopy.unbalancedBracketsOrQuotes");
  },
  get suspiciousWhitespace() {
    return t("batchEditorCopy.suspiciousWhitespace");
  },
  get glossaryMismatch() {
    return t("batchEditorCopy.glossaryMismatch");
  },
};

export const CONDITIONAL_BATCH_OPERATOR_LABELS: Record<
  ConditionalBatchOperator,
  string
> = {
  get contains() {
    return t("soundEffectReview.included");
  },
  get notContains() {
    return t("batchEditorCopy.doesNotContain");
  },
  get equals() {
    return t("batchEditorCopy.equals");
  },
  get notEquals() {
    return t("batchEditorCopy.notEqual");
  },
  get startsWith() {
    return t("batchEditorCopy.startsWith");
  },
  get endsWith() {
    return t("batchEditorCopy.endsWith");
  },
  get regex() {
    return t("batchEditorCopy.matchesPattern");
  },
  get notRegex() {
    return t("batchEditorCopy.doesNotMatchPattern");
  },
  get empty() {
    return t("conditionalBatch.when.empty");
  },
  get notEmpty() {
    return t("conditionalBatch.when.notEmpty");
  },
  get oneOf() {
    return t("batchEditorCopy.oneOf");
  },
  get notOneOf() {
    return t("batchEditorCopy.noneOf");
  },
  greaterThan: ">",
  greaterThanOrEqual: "≥",
  lessThan: "<",
  lessThanOrEqual: "≤",
  get between() {
    return t("batchEditorCopy.range");
  },
  get near() {
    return t("batchEditorCopy.similarColor");
  },
  get isTrue() {
    return t("batchEditorCopy.yes");
  },
  get isFalse() {
    return t("batchEditorCopy.no");
  },
};
