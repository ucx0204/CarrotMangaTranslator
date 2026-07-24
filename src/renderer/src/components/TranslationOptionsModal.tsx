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
      "translationWorkflowDefault" | "analysisScopeDefault" | "blockModeDefault"
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
  const work = React.useMemo(
    () => library.works.find((item) => item.id === chapter.workId) ?? null,
    [library.works, chapter.workId],
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

  const chapterOrder = React.useMemo(
    () => (work ? work.chapters.map((item) => item.id) : [chapter.id]),
    [work, chapter.id],
  );
  const runSelection = React.useMemo(
    () => buildRunSelection(chapterOrder, selection),
    [chapterOrder, selection],
  );

  const handleStart = (): void => {
    if (runSelection.length === 0) {
      return;
    }
    onPersistDefaults({
      translationWorkflowDefault: workflowMode,
      analysisScopeDefault: analysisScope,
      blockModeDefault: blockMode,
    });
    onStart({
      selection: runSelection,
      workflowMode,
      analysisScope,
      blockMode,
    });
    onClose();
  };

  return (
    <Modal
      title={t("sidebar.translate")}
      size="lg"
      onClose={onClose}
      closeOnBackdrop
      footer={
        <TranslationOptionsFooter
          onCancel={onClose}
          onStart={handleStart}
          startDisabled={runSelection.length === 0}
        />
      }
    >
      <TranslationOptionsForm
        chapter={chapter}
        work={work}
        selection={selection}
        onSelectionChange={setSelection}
        workflowMode={workflowMode}
        onWorkflowModeChange={setWorkflowMode}
        analysisScope={analysisScope}
        onAnalysisScopeChange={setAnalysisScope}
        blockMode={blockMode}
        onBlockModeChange={setBlockMode}
      />
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
};

function TranslationOptionsForm(
  props: TranslationOptionsFormProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  return (
    <div className="translate-options">
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
      />
      <p className="translate-options-hint" aria-live="polite">
        {t(
          `translationOptions.workflowOptions.${workflowTranslationKey(props.workflowMode)}.description`,
        )}
      </p>
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
      <OptionRow
        label={t("common.blocks")}
        options={getBlockModeOptions(tRenderer)}
        value={props.blockMode}
        onChange={props.onBlockModeChange}
      />
      {props.blockMode === "keep" ? (
        <p className="translate-options-hint">
          {t("translationOptions.keepBlocksHint")}
        </p>
      ) : null}
    </div>
  );
}

function workflowTranslationKey(
  mode: TranslationWorkflowMode,
): "standard" | "cumulative" | "twoPass" {
  return mode === "two-pass" ? "twoPass" : mode;
}

export function OptionRow<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <div className={`translate-options-row ${disabled ? "disabled" : ""}`}>
      <span className="translate-options-label">{label}</span>
      <div className="settings-mode-group" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`settings-preset-button ${value === option.id ? "active" : ""}`}
            aria-pressed={value === option.id}
            disabled={disabled}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
