import { appI18n } from "../appI18n";

import { type PageWorkflowStage } from "../../../shared/pageWorkflowStages";

const t = appI18n.getFixedT(null, "components");

export const STAGE_DESCRIPTIONS: Record<PageWorkflowStage, string> = {
  get detect() {
    return t("batchEditorCopy.findTextBlocksAndReadingOrderInTheSource");
  },
  get ocr() {
    return t("batchEditorCopy.fillEmptySourceTextInExistingBlocksWithOcr");
  },
  get "source-rules"() {
    return t(
      "batchEditorCopy.correctSourceTextWithSelectedRulesBeforeTranslation",
    );
  },
  get translate() {
    return t("batchEditorCopy.fillEmptyTranslationsUsingSavedSourceText");
  },
  get "translation-rules"() {
    return t("batchEditorCopy.cleanUpTranslationsWithSelectedRules");
  },
  get typography() {
    return t("batchEditorCopy.matchTranslatedTextFontsAndSizesToTheSource");
  },
  get "format-rules"() {
    return t(
      "batchEditorCopy.applyFontSizeAndEmphasisRulesAfterAutomaticFormatting",
    );
  },
  get erase() {
    return t("batchEditorCopy.eraseSourceTextWithinBlockAreas");
  },
  get layout() {
    return t("batchEditorCopy.fitTranslationsIntoBalloonsAndAdjustLineBreaks");
  },
  get review() {
    return t(
      "batchEditorCopy.checkEmptyTranslationsNumbersBracketsWhitespaceAndGlossaryMismatches",
    );
  },
};

export const OPTION_DESCRIPTIONS = {
  get autoFont() {
    return t("batchEditorCopy.automaticallyChooseAFontThatMatchesTheSource");
  },
  get autoSize() {
    return t("batchEditorCopy.matchTranslationTextSizeToTheSourceTextSize");
  },
  get bubbleLayout() {
    return t("batchEditorCopy.fitTranslationsInsideTheirBalloons");
  },
  get naturalLayout() {
    return t("batchEditorCopy.breakTranslatedTextAtNaturalReadingBoundaries");
  },
  get cumulative() {
    return t(
      "batchEditorCopy.carryTranslationContextFromPreviousPagesToTheNext",
    );
  },
};
