import React from "react";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type {
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
import { Button } from "./ui/Button";
import { CheckboxField } from "./ui/CheckboxField";
import { WarnIcon } from "./ui/icons";
import { Modal } from "./ui/Modal";
import { ModalActionBar } from "./ui/ModalActionBar";
import { ConfirmModal } from "./ConfirmModal";
import {
  type TranslationOptionsFormProps,
  useTranslationOptionsModalState,
} from "./translationOptionsState";

const WORKFLOW_OPTION_IDS: TranslationWorkflowMode[] = [
  "standard",
  "cumulative",
];

type TranslationDefaultsPatch = Pick<
  UiSettings,
  | "translationWorkflowDefault"
  | "blockModeDefault"
  | "autoFontMatchingDefault"
  | "naturalTextLayoutDefault"
  | "eraseOriginalWorkflowDefault"
  | "bubbleLayoutWorkflowDefault"
>;

type TranslationOptionsModalProps = {
  chapter: ChapterSnapshot;
  initialScope?: TranslationOptionsInitialScope;
  library: LibraryIndex;
  uiSettings: UiSettings | undefined;
  onStart: (options: TranslationFlowOptions) => void;
  onPersistDefaults: (patch: TranslationDefaultsPatch) => void;
  onClose: () => void;
};

export function TranslationOptionsModal({
  chapter,
  initialScope = "current-pending",
  library,
  uiSettings,
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
        closeOnBackdrop
        cardClassName="translation-options-modal"
        bodyClassName="translation-options-modal-body"
        footer={
          <TranslationOptionsFooter
            onCancel={onClose}
            onStart={actions.handleStart}
            overwriteRisk={state.overwriteRisk}
            saveAsDefault={actions.saveAsDefault}
            onSaveAsDefaultChange={actions.setSaveAsDefault}
            startDisabled={state.runSelection.length === 0}
          />
        }
      >
        <TranslationOptionsForm
          {...state.formProps}
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
    blockModeDefault: form.blockMode,
    autoFontMatchingDefault: form.autoFontMatching,
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
    blockMode: form.blockMode,
    autoFontMatching: form.autoFontMatching,
    naturalTextLayout: form.naturalTextLayout,
    eraseOriginalWorkflow: form.eraseOriginalWorkflow,
    bubbleLayoutWorkflow: form.bubbleLayoutWorkflow,
  };
}

function TranslationOptionsFooter({
  onCancel,
  onStart,
  overwriteRisk,
  saveAsDefault,
  onSaveAsDefaultChange,
  startDisabled,
}: {
  onCancel: () => void;
  onStart: () => void;
  overwriteRisk: boolean;
  saveAsDefault: boolean;
  onSaveAsDefaultChange: (value: boolean) => void;
  startDisabled: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <ModalActionBar
      leading={
        <CheckboxField
          className="translation-save-defaults"
          label={t("translationOptions.saveAsDefault")}
          checked={saveAsDefault}
          onCheckedChange={onSaveAsDefaultChange}
        />
      }
      actions={
        <>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={onStart} disabled={startDisabled}>
            {t(
              overwriteRisk
                ? "translationOptions.retranslateSelection"
                : "translationOptions.startSelection",
            )}
          </Button>
        </>
      }
    />
  );
}

function TranslationOptionsForm(
  props: TranslationOptionsFormProps,
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
            selection={props.selection}
            onChange={props.onSelectionChange}
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
            options={getBlockModeOptions(tRenderer)}
            value={props.blockMode}
            onChange={props.onBlockModeChange}
            description={t(
              `translationOptions.blockModeSummaries.${props.blockMode}`,
            )}
          />
          <div className="translate-options-toggle-grid">
            <NaturalTextLayoutOptions {...props} />
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
        <div className="translation-overwrite-warning" role="note">
          <WarnIcon size={18} aria-hidden="true" />
          <div>
            <strong>{t("translationOptions.overwriteWarning.title")}</strong>
            <span>{t("translationOptions.overwriteWarning.description")}</span>
          </div>
        </div>
      ) : null}
    </div>
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
        }))}
        value={props.workflowMode}
        onChange={props.onWorkflowModeChange}
        description={t(
          `translationOptions.workflowOptions.${props.workflowMode}.description`,
        )}
        showLabel={false}
      />
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
