import React from "react";
import { mangaGateway } from "../../api/mangaGateway";
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
    <>
      <UpdateSection />
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
          Paddle OCR 준비 상태와 선택한 번역 엔진이 실제로 뜨는지 함께
          확인합니다.
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
    </>
  );
}

function UpdateSection(): React.JSX.Element {
  const [info, setInfo] = React.useState<{
    currentVersion: string;
    releasesUrl: string;
  } | null>(null);

  React.useEffect(() => {
    let active = true;
    void mangaGateway
      .getAppUpdateInfo()
      .then((result) => {
        if (active) {
          setInfo(result);
        }
      })
      .catch((error) => {
        console.error("Failed to read app update info", error);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="settings-field-stack">
      <span>업데이트</span>
      <p className="muted-line">
        현재 버전: {info?.currentVersion ?? "확인 중..."}
      </p>
      <div className="settings-inline-actions">
        <button
          type="button"
          onClick={() => {
            void mangaGateway.openReleasesPage().catch((error) => {
              console.error("Failed to open releases page", error);
            });
          }}
        >
          업데이트 확인 (릴리스 페이지 열기)
        </button>
      </div>
      <p className="muted-line modal-note">
        새 버전 설치 파일을 같은 위치에 설치해도 모델·보관함·OCR 런타임 등
        데이터는 그대로 유지됩니다. 제거할 때 “데이터도 함께 삭제” 항목을 직접
        선택하지 않으면 데이터는 지워지지 않습니다.
      </p>
    </div>
  );
}
