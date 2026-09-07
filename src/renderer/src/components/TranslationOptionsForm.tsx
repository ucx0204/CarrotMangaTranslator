import React from "react";
import { useTranslation } from "react-i18next";
import type {
  TranslationWorkflowMode,
  CumulativeContextDetail,
} from "../../../shared/settingsTypes";
import { ChapterPagePicker } from "./ChapterPagePicker";
import { getBlockModeOptions } from "../lib/blockModeOptions";
import {
  OptionRow,
  ToggleOptionRow,
  TranslationCompletionOptions,
  TranslationOptionSection,
} from "./TranslationOptionControls";
import { TranslationOverwriteWarning } from "./TranslationOverwriteWarning";
import {
  resolveTranslationResumeContext,
  type TranslationOptionsFormProps,
} from "./translationOptionsState";
const WORKFLOW_OPTION_IDS: TranslationWorkflowMode[] = [
  "standard",
  "cumulative",
];
const CUMULATIVE_DETAIL_IDS: CumulativeContextDetail[] = [
  "detailed",
  "balanced",
  "essential",
];

export function TranslationOptionsForm(
  props: TranslationOptionsFormProps & {
    currentPageId?: string | null;
  },
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="translate-options">
      <div className="translate-options-selection">
        {props.work ? (
          <ChapterPagePicker
            work={props.work}
            currentChapter={props.chapter}
            currentPageId={props.currentPageId}
            selection={props.selection}
            onChange={props.onSelectionChange}
            resumeContext={resolveTranslationResumeContext(props)}
          />
        ) : (
          <p className="translate-options-hint">
            {t("translationOptions.workUnavailable")}
          </p>
        )}
      </div>
      <div className="translate-options-sections">
        <TranslationSettings {...props} />
      </div>
      {props.overwriteRisk ? (
        <TranslationOverwriteWarning
          title={t("translationOptions.overwriteWarning.title")}
          description={t("translationOptions.overwriteWarning.description")}
        />
      ) : null}
    </div>
  );
}

function AiFontSizeMatchingOptions(
  props: TranslationOptionsFormProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ToggleOptionRow
      label={t("translationOptions.fontSizeAutoFit")}
      pressed={props.aiFontSizeMatching}
      onChange={props.onAiFontSizeMatchingChange}
      description={t("translationOptions.fontSizeAutoFitSummary")}
    />
  );
}

function TranslationWorkflowOptions(
  props: TranslationOptionsFormProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <OptionRow
        label={t("translationOptions.workflowMode")}
        options={WORKFLOW_OPTION_IDS.map((id) => ({
          id,
          label: t(`translationOptions.workflowOptions.${id}.label`),
          tooltip: t(`translationOptions.workflowOptions.${id}.description`),
        }))}
        value={props.workflowMode}
        onChange={props.onWorkflowModeChange}
        showLabel={false}
      />
      {props.workflowMode === "cumulative" ? (
        <div className="translate-options-cumulative-detail">
          <OptionRow
            label={t("translationOptions.cumulativeDetail.label")}
            options={CUMULATIVE_DETAIL_IDS.map((id) => ({
              id,
              label: t(
                `translationOptions.cumulativeDetail.options.${id}.label`,
              ),
              tooltip: t(
                `translationOptions.cumulativeDetail.options.${id}.description`,
              ),
            }))}
            value={props.cumulativeContextDetail}
            onChange={props.onCumulativeContextDetailChange}
          />
        </div>
      ) : null}
    </>
  );
}

function NaturalTextLayoutOptions(
  props: TranslationOptionsFormProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ToggleOptionRow
      label={t("translationOptions.naturalTextLayout")}
      pressed={props.naturalTextLayout}
      onChange={props.onNaturalTextLayoutChange}
      description={t(
        `translationOptions.naturalTextLayoutSummaries.${props.naturalTextLayout ? "on" : "off"}`,
      )}
    />
  );
}

function AutoFontMatchingOptions(
  props: TranslationOptionsFormProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ToggleOptionRow
      label={t("translationOptions.autoFontMatching")}
      pressed={props.autoFontMatching}
      onChange={props.onAutoFontMatchingChange}
      description={t("translationOptions.autoFontMatchingSummary")}
    />
  );
}

function TranslationSettings(props: TranslationOptionsFormProps) {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  return (
    <>
      <TranslationOptionSection
        className="translate-options-section--quality"
        title={t("translationOptions.sections.quality")}
      >
        <TranslationWorkflowOptions {...props} />
      </TranslationOptionSection>
      <TranslationOptionSection
        title={t("translationOptions.sections.blockLayout")}
      >
        <OptionRow
          label={t("common.blocks")}
          options={getBlockModeOptions(tRenderer).map((option) => ({
            ...option,
            tooltip: t(`translationOptions.blockModeSummaries.${option.id}`),
          }))}
          value={props.blockMode}
          onChange={props.onBlockModeChange}
        />
        <div className="translate-options-toggle-grid">
          <NaturalTextLayoutOptions {...props} />
          <AiFontSizeMatchingOptions {...props} />
          <AutoFontMatchingOptions {...props} />
        </div>
      </TranslationOptionSection>
      <TranslationOptionSection
        title={t("translationOptions.sections.completion")}
      >
        <TranslationCompletionOptions {...props} />
      </TranslationOptionSection>
    </>
  );
}
