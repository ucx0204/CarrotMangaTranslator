import React from "react";
import type { TestState } from "../settingsModalTypes";

type TestSettingsPanelProps = {
  canSubmit: boolean;
  controlsBusy: boolean;
  jobActive: boolean;
  runModelTest: () => Promise<void>;
  testLogLines: string[];
  testLogRef: React.RefObject<HTMLDivElement | null>;
  testState: TestState;
};

export function TestSettingsPanel({
  canSubmit,
  controlsBusy,
  jobActive,
  runModelTest,
  testLogLines,
  testLogRef,
  testState,
}: TestSettingsPanelProps): React.JSX.Element {
  return (
    <div className="settings-field-stack">
      <span>설치/작동 확인</span>
      <div className="settings-inline-actions">
        <button
          type="button"
          onClick={() => void runModelTest()}
          disabled={controlsBusy || !canSubmit || jobActive}
        >
          {testState.status === "running" ? "확인 중..." : "OCR/모델 확인"}
        </button>
      </div>
      <p className="muted-line modal-note">
        Paddle OCR 준비 상태와 선택한 번역 엔진이 실제로 뜨는지 함께 확인합니다.
      </p>
      {jobActive ? (
        <p className="muted-line">
          번역 작업 중에는 설치/작동 확인을 실행할 수 없습니다.
        </p>
      ) : null}
      {testState.status !== "idle" ? (
        <div className={`settings-test-result ${testState.status}`}>
          <strong>{testState.message}</strong>
          {testState.detail ? <p>{testState.detail}</p> : null}
        </div>
      ) : null}
      {testLogLines.length > 0 ? (
        <div
          className="settings-test-log"
          ref={testLogRef}
          aria-label="설치/작동 확인 로그"
        >
          {testLogLines.map((line, index) => (
            <code key={`${index}-${line}`}>{line}</code>
          ))}
        </div>
      ) : null}
    </div>
  );
}
