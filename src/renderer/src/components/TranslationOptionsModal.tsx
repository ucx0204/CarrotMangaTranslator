/* eslint-disable max-lines-per-function */
import React from "react";
import type {
  ChapterSnapshot,
  UiSettings,
  WorkContextAnalysisScope,
} from "../../../shared/types";
import type { TranslationFlowOptions } from "../hooks/useTranslationActions";
import { Button, Modal } from "./ui";

type Scope = "pending" | "all";
type Target = "chapter" | "work";

const SCOPE_OPTIONS: { id: Scope; label: string }[] = [
  { id: "pending", label: "이어서" },
  { id: "all", label: "전체 다시" },
];

const TARGET_OPTIONS: { id: Target; label: string }[] = [
  { id: "chapter", label: "현재 화" },
  { id: "work", label: "작품 전체" },
];

const ANALYSIS_OPTIONS: { id: WorkContextAnalysisScope; label: string }[] = [
  { id: "work", label: "처음부터 다시" },
  { id: "missing", label: "비어있는 화만" },
  { id: "chapter", label: "현재 화만" },
];

export function TranslationOptionsModal({
  chapter,
  uiSettings,
  onStart,
  onPersistDefaults,
  onClose,
}: {
  chapter: ChapterSnapshot;
  uiSettings: UiSettings | undefined;
  onStart: (options: TranslationFlowOptions) => void;
  onPersistDefaults: (
    patch: Pick<UiSettings, "twoPassByDefault" | "analysisScopeDefault">,
  ) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [scope, setScope] = React.useState<Scope>("pending");
  const [target, setTarget] = React.useState<Target>("chapter");
  const [twoPass, setTwoPass] = React.useState(
    uiSettings?.twoPassByDefault ?? true,
  );
  const [analysisScope, setAnalysisScope] =
    React.useState<WorkContextAnalysisScope>(
      uiSettings?.analysisScopeDefault ?? "missing",
    );

  const handleStart = (): void => {
    onPersistDefaults({
      twoPassByDefault: twoPass,
      analysisScopeDefault: analysisScope,
    });
    onStart({ scope, target, twoPass, analysisScope });
    onClose();
  };

  return (
    <Modal
      title="번역"
      size="md"
      onClose={onClose}
      closeOnBackdrop
      footer={
        <>
          <Button onClick={onClose}>취소</Button>
          <Button variant="primary" onClick={handleStart}>
            번역 시작
          </Button>
        </>
      }
    >
      <div className="translate-options">
        <p className="translate-options-context">
          현재 화: <strong>{chapter.title}</strong>
        </p>
        <OptionRow
          label="번역 범위"
          options={SCOPE_OPTIONS}
          value={scope}
          onChange={setScope}
        />
        <OptionRow
          label="대상"
          options={TARGET_OPTIONS}
          value={target}
          onChange={setTarget}
        />
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
            품질을 높입니다. 전 페이지를 재번역하므로 시간이 더 걸립니다.
          </p>
        </div>
        <OptionRow
          label="자동 분석 범위"
          options={ANALYSIS_OPTIONS}
          value={analysisScope}
          onChange={setAnalysisScope}
          disabled={!twoPass}
        />
      </div>
    </Modal>
  );
}

function OptionRow<T extends string>({
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
