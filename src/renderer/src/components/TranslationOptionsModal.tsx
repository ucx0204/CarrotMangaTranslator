import React from "react";
import { useTranslation } from "react-i18next";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type {
  ChapterSnapshot,
  LibraryIndex,
  LibraryWorkSummary,
} from "../../../shared/libraryTypes";
import type {
  TranslationWorkflowMode,
  UiSettings,
} from "../../../shared/settingsTypes";
import type { WorkContextAnalysisScope } from "../../../shared/workContextAnalysisTypes";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
import { getBlockModeOptions } from "../lib/blockModeOptions";
import {
  buildRunSelection,
  type ChapterSelectionMap,
} from "../lib/translationSelection";
import { ChapterPagePicker } from "./ChapterPagePicker";
import {
  OptionRow,
  TranslationCompletionOptions,
  TranslationOptionSection,
} from "./TranslationOptionControls";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";

const ANALYSIS_OPTION_IDS: WorkContextAnalysisScope[] = [
  "work",
  "missing",
  "chapter",
];
const WORKFLOW_OPTION_IDS: TranslationWorkflowMode[] = [
  "standard",
  "cumulative",
  "two-pass",
];

type TranslationOptionsModalProps = {
  chapter: ChapterSnapshot;
  library: LibraryIndex;
  uiSettings: UiSettings | undefined;
  onStart: (options: TranslationFlowOptions) => void;
  onPersistDefaults: (
    patch: Pick<
      UiSettings,
      | "translationWorkflowDefault"
      | "analysisScopeDefault"
      | "blockModeDefault"
      | "naturalTextLayoutDefault"
      | "eraseOriginalWorkflowDefault"
      | "bubbleLayoutWorkflowDefault"
    >,
  ) => void;
  onClose: () => void;
};

export function TranslationOptionsModal({
  chapter,
  library,
  uiSettings,
  onStart,
  onPersistDefaults,
  onClose,
}: TranslationOptionsModalProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const state = useTranslationOptionsModalState(chapter, library, uiSettings);
  const handleStart = (): void => {
    if (state.runSelection.length === 0) return;
    onPersistDefaults({
      translationWorkflowDefault: state.formProps.workflowMode,
      analysisScopeDefault: state.formProps.analysisScope,
      blockModeDefault: state.formProps.blockMode,
      naturalTextLayoutDefault: state.formProps.naturalTextLayout,
      eraseOriginalWorkflowDefault: state.formProps.eraseOriginalWorkflow,
      bubbleLayoutWorkflowDefault: state.formProps.bubbleLayoutWorkflow,
    });
    onStart({
      selection: state.runSelection,
      workflowMode: state.formProps.workflowMode,
      analysisScope: state.formProps.analysisScope,
      blockMode: state.formProps.blockMode,
      naturalTextLayout: state.formProps.naturalTextLayout,
      eraseOriginalWorkflow: state.formProps.eraseOriginalWorkflow,
      bubbleLayoutWorkflow: state.formProps.bubbleLayoutWorkflow,
    });
    onClose();
  };
  return (
    <Modal
      title={t("sidebar.translate")}
      size="lg"
      onClose={onClose}
      closeOnBackdrop
      cardClassName="translation-options-modal"
      bodyClassName="translation-options-modal-body"
      footer={
        <TranslationOptionsFooter
          onCancel={onClose}
          onStart={handleStart}
          startDisabled={state.runSelection.length === 0}
        />
      }
    >
      <TranslationOptionsForm {...state.formProps} />
    </Modal>
  );
}

function TranslationOptionsFooter({
  onCancel,
  onStart,
  startDisabled,
}: {
  onCancel: () => void;
  onStart: () => void;
  startDisabled: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <Button onClick={onCancel}>{t("common.cancel")}</Button>
      <Button variant="primary" onClick={onStart} disabled={startDisabled}>
        {t("translationOptions.start")}
      </Button>
    </>
  );
}

type TranslationOptionsFormProps = {
  chapter: ChapterSnapshot;
  work: LibraryWorkSummary | null;
  selection: ChapterSelectionMap;
  onSelectionChange: (selection: ChapterSelectionMap) => void;
  workflowMode: TranslationWorkflowMode;
  onWorkflowModeChange: (mode: TranslationWorkflowMode) => void;
  analysisScope: WorkContextAnalysisScope;
  onAnalysisScopeChange: (scope: WorkContextAnalysisScope) => void;
  blockMode: AnalysisBlockMode;
  onBlockModeChange: (mode: AnalysisBlockMode) => void;
  naturalTextLayout: boolean;
  onNaturalTextLayoutChange: (enabled: boolean) => void;
  eraseOriginalWorkflow: boolean;
  onEraseOriginalWorkflowChange: (enabled: boolean) => void;
  bubbleLayoutWorkflow: boolean;
  onBubbleLayoutWorkflowChange: (enabled: boolean) => void;
};

function useTranslationOptionsModalState(
  chapter: ChapterSnapshot,
  library: LibraryIndex,
  uiSettings: UiSettings | undefined,
): {
  formProps: TranslationOptionsFormProps;
  runSelection: TranslationFlowOptions["selection"];
} {
  const work = React.useMemo(
    () => library.works.find((item) => item.id === chapter.workId) ?? null,
    [chapter.workId, library.works],
  );
  const [selection, setSelection] = React.useState<ChapterSelectionMap>(
    () => new Map([[chapter.id, { kind: "pending" }]]),
  );
  const [workflowMode, setWorkflowMode] = React.useState(
    uiSettings?.translationWorkflowDefault ?? "cumulative",
  );
  const [analysisScope, setAnalysisScope] =
    React.useState<WorkContextAnalysisScope>(
      uiSettings?.analysisScopeDefault ?? "missing",
    );
  const [blockMode, setBlockMode] = React.useState<AnalysisBlockMode>(
    uiSettings?.blockModeDefault ?? "auto",
  );
  const [naturalTextLayout, setNaturalTextLayout] = React.useState(
    uiSettings?.naturalTextLayoutDefault ?? true,
  );
  const completionDefaults = resolveInitialCompletionDefaults(uiSettings);
  const [eraseOriginalWorkflow, setEraseOriginalWorkflow] = React.useState(
    completionDefaults.eraseOriginal,
  );
  const [bubbleLayoutWorkflow, setBubbleLayoutWorkflow] = React.useState(
    completionDefaults.bubbleLayout,
  );
  const chapterOrder = React.useMemo(
    () => (work ? work.chapters.map((item) => item.id) : [chapter.id]),
    [chapter.id, work],
  );
  const runSelection = React.useMemo(
    () => buildRunSelection(chapterOrder, selection),
    [chapterOrder, selection],
  );
  return {
    formProps: {
      analysisScope,
      blockMode,
      bubbleLayoutWorkflow,
      chapter,
      eraseOriginalWorkflow,
      naturalTextLayout,
      onAnalysisScopeChange: setAnalysisScope,
      onBlockModeChange: setBlockMode,
      onBubbleLayoutWorkflowChange: setBubbleLayoutWorkflow,
      onEraseOriginalWorkflowChange: setEraseOriginalWorkflow,
      onNaturalTextLayoutChange: setNaturalTextLayout,
      onSelectionChange: setSelection,
      onWorkflowModeChange: setWorkflowMode,
      selection,
      work,
      workflowMode,
    },
    runSelection,
  };
}

function resolveInitialCompletionDefaults(uiSettings: UiSettings | undefined): {
  eraseOriginal: boolean;
  bubbleLayout: boolean;
} {
  if (uiSettings?.eraseOriginalWorkflowDefault === undefined) {
    return {
      eraseOriginal: uiSettings?.bubbleLayoutWorkflowDefault ?? false,
      bubbleLayout: true,
    };
  }
  return {
    eraseOriginal: uiSettings.eraseOriginalWorkflowDefault,
    bubbleLayout: uiSettings.bubbleLayoutWorkflowDefault ?? true,
  };
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
          <NaturalTextLayoutOptions {...props} />
        </TranslationOptionSection>
        <TranslationOptionSection
          title={t("translationOptions.sections.completion")}
        >
          <TranslationCompletionOptions {...props} />
        </TranslationOptionSection>
      </div>
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
          label: t(
            `translationOptions.workflowOptions.${workflowTranslationKey(id)}.label`,
          ),
        }))}
        value={props.workflowMode}
        onChange={props.onWorkflowModeChange}
        description={t(
          `translationOptions.workflowOptions.${workflowTranslationKey(props.workflowMode)}.description`,
        )}
        showLabel={false}
      />
      {props.workflowMode === "two-pass" ? (
        <OptionRow
          label={t("translationOptions.analysisScope")}
          options={ANALYSIS_OPTION_IDS.map((id) => ({
            id,
            label: t(`translationOptions.analysisOptions.${id}`),
          }))}
          value={props.analysisScope}
          onChange={props.onAnalysisScopeChange}
        />
      ) : null}
    </>
  );
}

function NaturalTextLayoutOptions(
  props: TranslationOptionsFormProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <OptionRow
      label={t("translationOptions.naturalTextLayout")}
      options={[
        { id: "off", label: t("translationOptions.naturalTextLayoutOff") },
        { id: "on", label: t("translationOptions.naturalTextLayoutOn") },
      ]}
      value={props.naturalTextLayout ? "on" : "off"}
      onChange={(value) => props.onNaturalTextLayoutChange(value === "on")}
      description={t(
        `translationOptions.naturalTextLayoutSummaries.${props.naturalTextLayout ? "on" : "off"}`,
      )}
    />
  );
}

function workflowTranslationKey(
  mode: TranslationWorkflowMode,
): "standard" | "cumulative" | "twoPass" {
  return mode === "two-pass" ? "twoPass" : mode;
}
