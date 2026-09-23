import type {
  TranslationOptionsModalProps,
  TranslationModalPresentation,
} from "./translationOptionsModalTypes";
import React from "react";
import { SegmentedControl } from "./ui/SegmentedControl";
import { PageWorkflowModal } from "./PageWorkflowModal";
import { TranslationOptionsForm } from "./TranslationOptionsForm";
import { useTranslation } from "react-i18next";
import type { UiSettings } from "../../../shared/settingsTypes";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
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

export function TranslationOptionsModal(
  props: TranslationOptionsModalProps,
): React.JSX.Element {
  return props.settings?.ocr.pipeline === "hayai" ? (
    <HayaiTranslationOptionsModal {...props} />
  ) : (
    <LegacyTranslationOptionsModal {...props} />
  );
}

function HayaiTranslationOptionsModal(props: TranslationOptionsModalProps) {
  const [mode, setMode] = React.useState(
    props.uiSettings?.hayaiTranslationUi ?? "workflow",
  );
  const [resizeFromWidth, setResizeFromWidth] = React.useState<string>();
  const switcherRef = React.useRef<HTMLDivElement>(null);
  const switchMode = (next: typeof mode) => {
    if (next === mode) return;
    const dialog = switcherRef.current?.closest('[role="dialog"]');
    setResizeFromWidth(`${dialog?.getBoundingClientRect().width ?? 880}px`);
    setMode(next);
    props.onPersistDefaults({ hayaiTranslationUi: next });
  };
  React.useEffect(() => {
    if (resizeFromWidth)
      switcherRef.current
        ?.querySelector<HTMLElement>('[aria-checked="true"]')
        ?.focus();
  }, [mode, resizeFromWidth]);
  const presentation = {
    resizeFromWidth,
    headerExtra: (
      <div ref={switcherRef}>
        <SegmentedControl
          ariaLabel="Hayai 작업 화면"
          singleRow
          value={mode}
          onChange={switchMode}
          options={[
            { id: "classic", label: "기존 버전" },
            { id: "workflow", label: "새 버전" },
          ]}
        />
      </div>
    ),
  };
  return mode === "workflow" ? (
    <PageWorkflowModal {...props} {...presentation} />
  ) : (
    <LegacyTranslationOptionsModal {...props} {...presentation} />
  );
}

function LegacyTranslationOptionsModal({
  headerExtra,
  resizeFromWidth,
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
}: TranslationOptionsModalProps &
  TranslationModalPresentation): React.JSX.Element {
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
        width="min(880px, 100%)"
        headerExtra={headerExtra}
        resizeFromWidth={resizeFromWidth}
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
