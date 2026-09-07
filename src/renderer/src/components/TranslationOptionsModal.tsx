import React from "react";
import { TranslationOptionsForm } from "./TranslationOptionsForm";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type { AppSettings, UiSettings } from "../../../shared/settingsTypes";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
import type { TranslationOptionsInitialScope } from "../lib/translationSelection";
import { Modal } from "./ui/Modal";
import { ConfirmModal } from "./ConfirmModal";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";
import { TranslationOptionsActionBar } from "./TranslationOptionsActionBar";
import {
  type TranslationOptionsFormProps,
  isCodexErasureBlocked,
  useTranslationOptionsModalState,
} from "./translationOptionsState";

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
  | "codexErasureDefault"
>;

type TranslationOptionsModalProps = {
  settings?: AppSettings | null;
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
  settings,
  chapter,
  currentPageId,
  initialScope = "current-pending",
  library,
  uiSettings,
  sourceLanguage,
  targetLanguage,
  onClose,
  ...startCallbacks
}: TranslationOptionsModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = useTranslationOptionsModalState(
    chapter,
    initialScope,
    library,
    uiSettings,
    { sourceLanguage, targetLanguage },
    settings,
  );
  const actions = useTranslationStartActions({
    formProps: state.formProps,
    onClose,
    ...startCallbacks,
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
            startDisabled={
              state.runSelection.length === 0 ||
              isCodexErasureBlocked(state.formProps)
            }
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
        />
      </Modal>
      <OverwriteConfirmation actions={actions} />
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
  const starting = React.useRef(false);
  const performStart = async (): Promise<void> => {
    if (runSelection.length === 0 || starting.current) return;
    if (isCodexErasureBlocked(formProps)) return;
    starting.current = true;
    if (saveAsDefault) onPersistDefaults(buildDefaultsPatch(formProps));
    handoffActiveModalToWorkCenter();
    const base = buildTranslationFlowOptions(formProps, runSelection);
    onStart(base);
    onClose();
  };
  const handleStart = (): void => {
    if (overwriteRisk) {
      setOverwriteConfirmOpen(true);
      return;
    }
    void performStart();
  };
  const confirmOverwrite = (): void => {
    setOverwriteConfirmOpen(false);
    void performStart();
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
    ...(form.codexErasure
      ? { codexErasureDefault: form.codexErasure.enabled }
      : {}),
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
    ...(form.eraseOriginalWorkflow && form.codexErasure?.enabled
      ? { inpaintingEngine: "codex" as const }
      : {}),
    bubbleLayoutWorkflow:
      form.eraseOriginalWorkflow && form.bubbleLayoutWorkflow,
  };
}

function OverwriteConfirmation({
  actions,
}: {
  actions: ReturnType<typeof useTranslationStartActions>;
}) {
  const { t } = useTranslation("components");
  return actions.overwriteConfirmOpen ? (
    <ConfirmModal
      title={t("translationOptions.overwriteConfirm.title")}
      message={t("translationOptions.overwriteConfirm.message")}
      detail={t("translationOptions.overwriteConfirm.detail")}
      confirmLabel={t("translationOptions.overwriteConfirm.action")}
      confirmVariant="danger"
      onCancel={() => actions.setOverwriteConfirmOpen(false)}
      onConfirm={actions.confirmOverwrite}
    />
  ) : null;
}
