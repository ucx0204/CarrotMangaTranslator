import React from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("components");
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.local.modelFile")}</span>
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
          {t("settings.gemma.local.chooseFile")}
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
  const { t } = useTranslation("components");
  return (
    <div className="settings-field-stack">
      <span>{t("settings.gemma.local.mmprojFile")}</span>
      <div className="settings-file-row">
        <input
          value={localMmprojPath}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setLocalMmprojPath(event.target.value);
          }}
          placeholder={t("settings.gemma.local.mmprojPlaceholder")}
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
          {t("settings.gemma.local.chooseFile")}
        </button>
      </div>
      <p className="muted-line modal-note">
        {t("settings.gemma.local.mmprojDescription")}
      </p>
    </div>
  );
}
