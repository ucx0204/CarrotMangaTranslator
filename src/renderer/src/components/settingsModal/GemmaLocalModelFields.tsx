import React from "react";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";

type LocalModelFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "clearTestState"
  | "controlsBusy"
  | "localMmprojPath"
  | "localModelInputRef"
  | "localModelPath"
  | "pickLocalMmprojFile"
  | "pickLocalModelFile"
  | "setLocalMmprojPath"
  | "setLocalModelPath"
  | "submit"
>;

export function LocalModelFields(
  props: LocalModelFieldsProps,
): React.JSX.Element {
  return (
    <>
      <LocalModelFileField {...props} />
      <LocalMmprojFileField {...props} />
    </>
  );
}

function LocalModelFileField({
  clearTestState,
  controlsBusy,
  localModelInputRef,
  localModelPath,
  pickLocalModelFile,
  setLocalModelPath,
  submit,
}: LocalModelFieldsProps): React.JSX.Element {
  return (
    <div className="settings-field-stack">
      <span>로컬 모델 파일</span>
      <div className="settings-file-row">
        <input
          ref={localModelInputRef}
          value={localModelPath}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setLocalModelPath(event.target.value);
          }}
          placeholder="C:\\models\\my-model.gguf"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
        <button
          type="button"
          onClick={() => void pickLocalModelFile()}
          disabled={controlsBusy}
        >
          파일 선택
        </button>
      </div>
    </div>
  );
}

function LocalMmprojFileField({
  clearTestState,
  controlsBusy,
  localMmprojPath,
  pickLocalMmprojFile,
  setLocalMmprojPath,
  submit,
}: LocalModelFieldsProps): React.JSX.Element {
  return (
    <div className="settings-field-stack">
      <span>mmproj 파일</span>
      <div className="settings-file-row">
        <input
          value={localMmprojPath}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setLocalMmprojPath(event.target.value);
          }}
          placeholder="같은 폴더면 자동 탐지, 필요하면 직접 지정"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              submit();
            }
          }}
        />
        <button
          type="button"
          onClick={() => void pickLocalMmprojFile()}
          disabled={controlsBusy}
        >
          파일 선택
        </button>
      </div>
      <p className="muted-line modal-note">
        mmproj는 같은 폴더에서 자동으로 찾아보고, 안 잡히면 직접 지정할 수
        있습니다.
      </p>
    </div>
  );
}
