import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type {
  CumulativeContextDetail,
  TranslationWorkflowMode,
  UiSettings,
} from "../../../shared/settingsTypes";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
import { getBlockModeOptions } from "../lib/blockModeOptions";
import type { TranslationOptionsInitialScope } from "../lib/translationSelection";
import { ChapterPagePicker } from "./ChapterPagePicker";
import {
  OptionRow,
  ToggleOptionRow,
  TranslationCompletionOptions,
  TranslationOptionSection,
} from "./TranslationOptionControls";
import { Modal } from "./ui/Modal";
import { ConfirmModal } from "./ConfirmModal";
import { TranslationOverwriteWarning } from "./TranslationOverwriteWarning";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";
import { TranslationOptionsActionBar } from "./TranslationOptionsActionBar";
import {
  type TranslationOptionsFormProps,
  resolveTranslationResumeContext,
  useTranslationOptionsModalState,
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

type TranslationDefaultsPatch = Pick<
  UiSettings,
  | "translationWorkflowDefault"
  | "cumulativeContextDetailDefault"
  | "blockModeDefault"
  | "autoFontMatchingDefault"
  | "aiFontSizeMatchingDefault"
  | "naturalTextLayoutDefault"
  | "eraseOriginalWorkflowDefault"
  | "bubbleLayoutWorkflowDefault"
>;

type TranslationOptionsModalProps = {
  chapter: ChapterSnapshot;
  currentPageId?: string | null;
  initialScope?: TranslationOptionsInitialScope;
  library: LibraryIndex;
  uiSettings: UiSettings | undefined;
  sourceLanguage?: string;
  targetLanguage?: string;
  onStart: (options: TranslationFlowOptions) => void;
  onPersistDefaults: (patch: TranslationDefaultsPatch) => void;
  onClose: () => void;
};

export function TranslationOptionsModal({
  chapter,
  currentPageId,
  initialScope = "current-pending",
  library,
  uiSettings,
  sourceLanguage,
  targetLanguage,
  onStart,
  onPersistDefaults,
  onClose,
}: TranslationOptionsModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = useTranslationOptionsModalState(
    chapter,
    initialScope,
    library,
    uiSettings,
    { sourceLanguage, targetLanguage },
  );
  const actions = useTranslationStartActions({
    formProps: state.formProps,
    onClose,
    onPersistDefaults,
    onStart,
    overwriteRisk: state.overwriteRisk,
    runSelection: state.runSelection,
  });
  return (
    <>
      <Modal
        title={t("translationOptions.title")}
        size="lg"
        onClose={onClose}
        fillHeight
        cardClassName="translation-options-modal page-picker-fill-modal"
        bodyClassName="translation-options-modal-body page-picker-fill-modal-body"
        footer={
          <TranslationOptionsActionBar
            onCancel={onClose}
            onStart={actions.handleStart}
            saveAsDefault={actions.saveAsDefault}
            onSaveAsDefaultChange={actions.setSaveAsDefault}
            startDisabled={state.runSelection.length === 0}
            startLabel={t(
              state.hasResumeSelection
                ? "translationOptions.continueSelection"
                : "translationOptions.startSelection",
            )}
          />
        }
      >
        <TranslationOptionsForm
          {...state.formProps}
          currentPageId={currentPageId}
          overwriteRisk={state.overwriteRisk}
        />
      </Modal>
      {actions.overwriteConfirmOpen ? (
        <ConfirmModal
          title={t("translationOptions.overwriteConfirm.title")}
          message={t("translationOptions.overwriteConfirm.message")}
          detail={t("translationOptions.overwriteConfirm.detail")}
          confirmLabel={t("translationOptions.overwriteConfirm.action")}
          confirmVariant="danger"
          onCancel={() => actions.setOverwriteConfirmOpen(false)}
          onConfirm={actions.confirmOverwrite}
        />
      ) : null}
    </>
  );
}

function useTranslationStartActions({
  formProps,
  onClose,
  onPersistDefaults,
  onStart,
  overwriteRisk,
  runSelection,
}: {
  formProps: TranslationOptionsFormProps;
  onClose: () => void;
  onPersistDefaults: (patch: TranslationDefaultsPatch) => void;
  onStart: (options: TranslationFlowOptions) => void;
  overwriteRisk: boolean;
  runSelection: TranslationFlowOptions["selection"];
}) {
  const [saveAsDefault, setSaveAsDefault] = React.useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = React.useState(false);
  const performStart = (): void => {
    if (runSelection.length === 0) return;
    if (saveAsDefault) onPersistDefaults(buildDefaultsPatch(formProps));
    handoffActiveModalToWorkCenter();
    onStart(buildTranslationFlowOptions(formProps, runSelection));
    onClose();
  };
  const handleStart = (): void => {
    if (overwriteRisk) {
      setOverwriteConfirmOpen(true);
      return;
    }
    performStart();
  };
  const confirmOverwrite = (): void => {
    setOverwriteConfirmOpen(false);
    performStart();
  };
  return {
    confirmOverwrite,
    handleStart,
    overwriteConfirmOpen,
    saveAsDefault,
    setOverwriteConfirmOpen,
    setSaveAsDefault,
  };
}

function buildDefaultsPatch(
  form: TranslationOptionsFormProps,
): TranslationDefaultsPatch {
  return {
    translationWorkflowDefault: form.workflowMode,
    cumulativeContextDetailDefault: form.cumulativeContextDetail,
    blockModeDefault: form.blockMode,
    autoFontMatchingDefault: form.autoFontMatching,
    aiFontSizeMatchingDefault: form.aiFontSizeMatching,
    naturalTextLayoutDefault: form.naturalTextLayout,
    eraseOriginalWorkflowDefault: form.eraseOriginalWorkflow,
    bubbleLayoutWorkflowDefault: form.bubbleLayoutWorkflow,
  };
}

function buildTranslationFlowOptions(
  form: TranslationOptionsFormProps,
  selection: TranslationFlowOptions["selection"],
): TranslationFlowOptions {
  return {
    selection,
    workflowMode: form.workflowMode,
    cumulativeContextDetail: form.cumulativeContextDetail,
    blockMode: form.blockMode,
    autoFontMatching: form.autoFontMatching,
    aiFontSizeMatching: form.aiFontSizeMatching,
    naturalTextLayout: form.naturalTextLayout,
    eraseOriginalWorkflow: form.eraseOriginalWorkflow,
    bubbleLayoutWorkflow:
      form.eraseOriginalWorkflow && form.bubbleLayoutWorkflow,
  };
}

function TranslationOptionsForm(
  props: TranslationOptionsFormProps & { currentPageId?: string | null },
): React.JSX.Element {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
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
