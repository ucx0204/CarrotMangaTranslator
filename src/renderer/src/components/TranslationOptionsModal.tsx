/* eslint-disable max-lines-per-function */
import React from "react";
import type { AnalysisBlockMode } from "../../../shared/analysisTypes";
import type {
  ChapterSnapshot,
  LibraryIndex,
} from "../../../shared/libraryTypes";
import type { UiSettings } from "../../../shared/settingsTypes";
import type { WorkContextAnalysisScope } from "../../../shared/workContextAnalysisTypes";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
import { BLOCK_MODE_OPTIONS } from "../lib/blockModeOptions";
import {
  buildRunSelection,
  type ChapterSelectionMap,
} from "../lib/translationSelection";
import { ChapterPagePicker } from "./ChapterPagePicker";
import { Button, Modal } from "./ui";

const ANALYSIS_OPTIONS: { id: WorkContextAnalysisScope; label: string }[] = [
  { id: "work", label: "처음부터 다시" },
  { id: "missing", label: "비어있는 화만" },
  { id: "chapter", label: "현재 화만" },
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
      title="번역"
      size="lg"
      onClose={onClose}
      closeOnBackdrop
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button
            variant="primary"
            onClick={handleStart}
            disabled={runSelection.length === 0}
          >
            번역 시작
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
            작품 정보를 불러오지 못했습니다. 현재 화만 번역합니다.
          </p>
        )}

        <div className="translate-options-twopass">
          <label className="inline-toggle translate-options-toggle">
            <input
              type="checkbox"
              checked={twoPass}
              onChange={(event) => setTwoPass(event.target.checked)}
            />
            2차 번역 (품질 향상)
          </label>
          <p className="translate-options-hint">
            1차 번역 후 AI가 용어·캐릭터·맥락을 분석하고, 그 결과로 다시 번역해
            품질을 높입니다. 선택한 페이지를 다시 번역하므로 시간이 더 걸립니다.
          </p>
        </div>
        <OptionRow
          label="자동 분석 범위"
          options={ANALYSIS_OPTIONS}
          value={analysisScope}
          onChange={setAnalysisScope}
          disabled={!twoPass}
        />
        <OptionRow
          label="블록"
          options={BLOCK_MODE_OPTIONS}
          value={blockMode}
          onChange={setBlockMode}
        />
        {blockMode === "keep" ? (
          <p className="translate-options-hint">
            블록이 있는 페이지는 영역·서식을 그대로 두고 텍스트만 다시 채웁니다.
            블록이 없는 페이지는 자동 생성됩니다.
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
