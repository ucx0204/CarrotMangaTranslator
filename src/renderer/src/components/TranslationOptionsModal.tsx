/* eslint-disable max-lines-per-function */
import React from "react";
import { useTranslation } from "react-i18next";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import type { WorkContextAnalysisScope } from "../../../shared/workContextAnalysisTypes";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
import { getBlockModeOptions } from "../lib/blockModeOptions";
import {
  buildRunSelection,
  type ChapterSelectionMap,
} from "../lib/translationSelection";
import { ChapterPagePicker } from "./ChapterPagePicker";
import { Button, Modal } from "./ui";

const ANALYSIS_OPTION_IDS: WorkContextAnalysisScope[] = [
  "work",
  "missing",
  "chapter",
];

export function TranslationOptionsModal({
  chapter,
  library,
  uiSettings,
  onStart,
  onPersistDefaults,
  onClose,
}: {
  chapter: ChapterSnapshot;
  library: LibraryIndex;
  uiSettings: UiSettings | undefined;
  onStart: (options: TranslationFlowOptions) => void;
  onPersistDefaults: (
    patch: Pick<
      UiSettings,
      "twoPassByDefault" | "analysisScopeDefault" | "blockModeDefault"
    >,
  ) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const { t: tRenderer } = useTranslation("renderer");
  const work = React.useMemo(
    () => library.works.find((item) => item.id === chapter.workId) ?? null,
    [library.works, chapter.workId],
  );
  const [selection, setSelection] = React.useState<ChapterSelectionMap>(
    () => new Map([[chapter.id, { kind: "pending" }]]),
  );
  const [twoPass, setTwoPass] = React.useState(
    uiSettings?.twoPassByDefault ?? true,
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
      twoPassByDefault: twoPass,
      analysisScopeDefault: analysisScope,
      blockModeDefault: blockMode,
    });
    onStart({ selection: runSelection, twoPass, analysisScope, blockMode });
    onClose();
  };

  return (
    <Modal
      title={t("sidebar.translate")}
      size="lg"
      onClose={onClose}
      closeOnBackdrop
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            onClick={handleStart}
            disabled={runSelection.length === 0}
          >
            {t("translationOptions.start")}
          </Button>
        </>
      }
    >
      <div className="translate-options">
        {work ? (
          <ChapterPagePicker
            work={work}
            currentChapter={chapter}
            selection={selection}
            onChange={setSelection}
          />
        ) : (
          <p className="translate-options-hint">
            {t("translationOptions.workUnavailable")}
          </p>
        )}

        <div className="translate-options-twopass">
          <label className="inline-toggle translate-options-toggle">
            <input
              type="checkbox"
              checked={twoPass}
              onChange={(event) => setTwoPass(event.target.checked)}
            />
            {t("translationOptions.secondPass")}
          </label>
          <p className="translate-options-hint">
            {t("translationOptions.secondPassHint")}
          </p>
        </div>
        <OptionRow
          label={t("translationOptions.analysisScope")}
          options={ANALYSIS_OPTION_IDS.map((id) => ({
            id,
            label: t(`translationOptions.analysisOptions.${id}`),
          }))}
          value={analysisScope}
          onChange={setAnalysisScope}
          disabled={!twoPass}
        />
        <OptionRow
          label={t("common.blocks")}
          options={getBlockModeOptions(tRenderer)}
          value={blockMode}
          onChange={setBlockMode}
        />
        {blockMode === "keep" ? (
          <p className="translate-options-hint">
            {t("translationOptions.keepBlocksHint")}
          </p>
        ) : null}
      </div>
    </Modal>
  );
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
