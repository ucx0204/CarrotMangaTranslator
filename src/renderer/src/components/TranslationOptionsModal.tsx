import { useFonts } from "../fonts/useFonts";
import { useCodexPreferences } from "../hooks/useCodexPreferences";
import { CodexFontEditor, CodexPreferencesSaveError } from "./CodexFontEditor";
import React from "react";
import type { CodexTypesettingPreferences } from "../../../shared/codexTypesettingTypes";
import { TranslationOptionsForm } from "./TranslationOptionsForm";
import { useTranslation } from "react-i18next";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
import type { TranslationOptionsInitialScope } from "../lib/translationSelection";
import { Modal } from "./ui/Modal";
import { ConfirmModal } from "./ConfirmModal";
import { handoffActiveModalToWorkCenter } from "../lib/modalWorkCenterHandoff";
import { TranslationOptionsActionBar } from "./TranslationOptionsActionBar";
import {
  type TranslationOptionsFormProps,
  useTranslationOptionsModalState,
} from "./translationOptionsState";

type TranslationDefaultsPatch = Pick<
  UiSettings,
  | "codexTypesettingPreferences"
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
  codexDelegateAll?: boolean;
  codexUnavailable?: boolean;
  onSaveCodexPreferences?: (
    value: CodexTypesettingPreferences,
  ) => Promise<CodexTypesettingPreferences>;
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
  codexDelegateAll = false,
  codexUnavailable = false,
  onSaveCodexPreferences,
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
  const codex = useCodexPreferences(
    uiSettings?.codexTypesettingPreferences,
    targetLanguage ?? "ko",
    codexDelegateAll,
    onSaveCodexPreferences,
  );
  const [fontEditorOpen, setFontEditorOpen] = React.useState(false);
  const close = () => closeAfterSave(codexDelegateAll, codex.flush, onClose);
  const state = useTranslationOptionsModalState(
    chapter,
    initialScope,
    library,
    uiSettings,
    { sourceLanguage, targetLanguage },
  );
  const actions = useTranslationStartActions({
    beforeStart: codexDelegateAll ? codex.flush : undefined,
    codexPreferences: codex.value,
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
        onClose={() => void close()}
        fillHeight
        cardClassName="translation-options-modal page-picker-fill-modal"
        bodyClassName="translation-options-modal-body page-picker-fill-modal-body"
        footer={
          <TranslationFooter
            delegated={codexDelegateAll}
            unavailable={codexUnavailable}
            close={close}
            actions={actions}
            state={state}
            valid={codex.valid && !codex.busy}
            preferences={codex.value}
          />
        }
      >
        <TranslationPreferencesForm
          state={state}
          codex={codex}
          currentPageId={currentPageId}
          onEditFonts={() => setFontEditorOpen(true)}
        />
      </Modal>
      <TranslationFontEditor
        open={fontEditorOpen}
        codex={codex}
        pages={chapter.pages}
        currentPageId={currentPageId}
        onClose={() => setFontEditorOpen(false)}
      />
      <OverwriteConfirmation actions={actions} />
    </>
  );
}

function useTranslationStartActions({
  beforeStart,
  codexPreferences,
  formProps,
  onClose,
  onPersistDefaults,
  onStart,
  overwriteRisk,
  runSelection,
}: {
  beforeStart?: () => Promise<boolean>;
  codexPreferences: CodexTypesettingPreferences;
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
    starting.current = true;
    if (beforeStart && !(await beforeStart())) {
      starting.current = false;
      return;
    }
    if (saveAsDefault && !codexPreferences.enabled)
      onPersistDefaults({
        ...(codexPreferences.enabled ? {} : buildDefaultsPatch(formProps)),
      });
    handoffActiveModalToWorkCenter();
    const base = buildTranslationFlowOptions(formProps, runSelection);
    const preset = codexPreferences.presets.find(
      (item) => item.id === codexPreferences.selectedPresetId,
    );
    const sfxRendering = codexPreferences.sfxRendering ?? "image";
    onStart(
      codexPreferences.enabled && preset
        ? {
            ...base,
            codexTypesetting: {
              version: 1,
              preset,
              sfxRendering,
              eraseOriginal: codexPreferences.eraseOriginal !== false,
            },
            blockMode: "auto",
            autoFontMatching: false,
            aiFontSizeMatching: false,
            naturalTextLayout: false,
            eraseOriginalWorkflow: false,
            bubbleLayoutWorkflow: false,
          }
        : base,
    );
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

function TranslationFooter({
  unavailable,
  preferences,
  delegated,
  close,
  actions,
  state,
  valid,
}: {
  preferences: CodexTypesettingPreferences;
  delegated: boolean;
  unavailable: boolean;
  close: () => Promise<void>;
  actions: ReturnType<typeof useTranslationStartActions>;
  state: ReturnType<typeof useTranslationOptionsModalState>;
  valid: boolean;
}) {
  const { t } = useTranslation("components");
  const { baseOptions, ready } = useFonts();
  const preset = preferences.presets.find(
    (item) => item.id === preferences.selectedPresetId,
  );
  const missing =
    delegated &&
    (ready === false ||
      preset?.fonts.some(
        (font) => !baseOptions.some((option) => option.id === font.fontId),
      ));
  return (
    <TranslationOptionsActionBar
      showSaveAsDefault={!delegated}
      onCancel={() => void close()}
      onStart={actions.handleStart}
      saveAsDefault={actions.saveAsDefault}
      onSaveAsDefaultChange={actions.setSaveAsDefault}
      startDisabled={
        unavailable || state.runSelection.length === 0 || !valid || missing
      }
      startLabel={t(
        state.hasResumeSelection
          ? "translationOptions.continueSelection"
          : "translationOptions.startSelection",
      )}
    />
  );
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

function TranslationFontEditor({
  open,
  codex,
  pages,
  currentPageId,
  onClose,
}: {
  open: boolean;
  codex: ReturnType<typeof useCodexPreferences>;
  pages: ChapterSnapshot["pages"];
  currentPageId: string | null | undefined;
  onClose: () => void;
}) {
  return open ? (
    <CodexFontEditor
      value={codex.value}
      onChange={codex.setValue}
      pages={pages}
      currentPageId={currentPageId}
      flush={codex.flush}
      onSelectPreset={codex.selectPreset}
      error={codex.error}
      busy={codex.busy}
      onClose={onClose}
    />
  ) : null;
}

function TranslationPreferencesForm({
  state,
  codex,
  currentPageId,
  onEditFonts,
}: {
  state: ReturnType<typeof useTranslationOptionsModalState>;
  codex: ReturnType<typeof useCodexPreferences>;
  currentPageId?: string | null;
  onEditFonts: () => void;
}) {
  return (
    <>
      <TranslationOptionsForm
        {...state.formProps}
        onEditFonts={onEditFonts}
        onSelectCodexPreset={codex.selectPreset}
        codexPreferences={codex.value}
        onCodexPreferencesChange={codex.setValue}
        currentPageId={currentPageId}
      />
      <CodexPreferencesSaveError error={codex.error} retry={codex.flush} />
    </>
  );
}

async function closeAfterSave(
  delegated: boolean,
  flush: () => Promise<boolean>,
  close: () => void,
) {
  if (!delegated || (await flush())) close();
}
