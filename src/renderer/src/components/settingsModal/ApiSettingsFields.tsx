import React from "react";
import { useTranslation } from "react-i18next";
import type { ApiReasoningEffort } from "../../../../shared/settingsTypes";
import { EyeIcon, EyeOffIcon, IconButton } from "../ui";
import { API_REASONING_OPTIONS } from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";

type ApiSettingsFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "apiBaseUrl"
  | "apiCustomHeadersJson"
  | "apiExtraBodyJson"
  | "apiKey"
  | "apiModel"
  | "apiReasoningEffort"
  | "apiTemperature"
  | "apiTopK"
  | "apiTopP"
  | "clearTestState"
  | "controlsBusy"
  | "setApiBaseUrl"
  | "setApiCustomHeadersJson"
  | "setApiExtraBodyJson"
  | "setApiKey"
  | "setApiModel"
  | "setApiReasoningEffort"
  | "setApiTemperature"
  | "setApiTopK"
  | "setApiTopP"
  | "submit"
>;

export function ApiSettingsFields(
  props: ApiSettingsFieldsProps,
): React.JSX.Element {
  const [showApiKey, setShowApiKey] = React.useState(false);
  return (
    <>
      <ApiConnectionFields
        {...props}
        showApiKey={showApiKey}
        setShowApiKey={setShowApiKey}
      />
      <ApiAdvancedRequestFields {...props} />
    </>
  );
}

function ApiConnectionFields({
  apiBaseUrl,
  apiKey,
  apiModel,
  clearTestState,
  controlsBusy,
  setApiBaseUrl,
  setApiKey,
  setApiModel,
  setShowApiKey,
  showApiKey,
  submit,
}: ApiSettingsFieldsProps & {
  showApiKey: boolean;
  setShowApiKey: React.Dispatch<React.SetStateAction<boolean>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <label>
        {t("settings.api.baseUrl")}
        <input
          value={apiBaseUrl}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setApiBaseUrl(event.target.value);
          }}
          placeholder="https://api.openai.com/v1"
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </label>
      <label>
        {t("settings.api.model")}
        <input
          value={apiModel}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setApiModel(event.target.value);
          }}
          placeholder="gpt-5.5"
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
      </label>
      <label>
        {t("settings.api.key")}
        <div className="settings-file-row">
          <input
            type={showApiKey ? "text" : "password"}
            value={apiKey}
            disabled={controlsBusy}
            onChange={(event) => {
              clearTestState();
              setApiKey(event.target.value);
            }}
            placeholder={t("settings.api.keyPlaceholder")}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <IconButton
            label={
              showApiKey ? t("settings.api.hideKey") : t("settings.api.showKey")
            }
            aria-pressed={showApiKey}
            disabled={controlsBusy}
            onClick={() => setShowApiKey((value) => !value)}
          >
            {showApiKey ? <EyeOffIcon /> : <EyeIcon />}
          </IconButton>
        </div>
      </label>
    </>
  );
}

function ApiAdvancedRequestFields(
  props: ApiSettingsFieldsProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <details className="settings-advanced">
      <summary>{t("settings.api.advanced.title")}</summary>
      <p className="muted-line modal-note">
        {t("settings.api.advanced.description")}
      </p>
      <ApiScalarAdvancedFields {...props} />
      <ApiJsonAdvancedFields {...props} />
    </details>
  );
}

function ApiScalarAdvancedFields({
  apiReasoningEffort,
  apiTemperature,
  apiTopK,
  apiTopP,
  clearTestState,
  controlsBusy,
  setApiReasoningEffort,
  setApiTemperature,
  setApiTopK,
  setApiTopP,
}: ApiSettingsFieldsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <div className="settings-advanced-grid">
      <label>
        {t("settings.api.advanced.temperature")}
        <input
          type="number"
          min={0}
          max={2}
          step={0.05}
          value={apiTemperature}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setApiTemperature(event.target.value);
          }}
        />
      </label>
      <label>
        {t("settings.api.advanced.topP")}
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={apiTopP}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setApiTopP(event.target.value);
          }}
        />
      </label>
      <label>
        {t("settings.api.advanced.topK")}
        <input
          type="number"
          min={1}
          max={1000}
          step={1}
          value={apiTopK}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setApiTopK(event.target.value);
          }}
        />
      </label>
      <ApiReasoningEffortField
        apiReasoningEffort={apiReasoningEffort}
        clearTestState={clearTestState}
        controlsBusy={controlsBusy}
        setApiReasoningEffort={setApiReasoningEffort}
      />
    </div>
  );
}

function ApiReasoningEffortField({
  apiReasoningEffort,
  clearTestState,
  controlsBusy,
  setApiReasoningEffort,
}: Pick<
  ApiSettingsFieldsProps,
  | "apiReasoningEffort"
  | "clearTestState"
  | "controlsBusy"
  | "setApiReasoningEffort"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <label>
      {t("settings.api.advanced.reasoningEffort")}
      <select
        value={apiReasoningEffort}
        disabled={controlsBusy}
        onChange={(event) => {
          clearTestState();
          setApiReasoningEffort(event.target.value as ApiReasoningEffort | "");
        }}
      >
        {API_REASONING_OPTIONS.map((option) => (
          <option key={option.id || "omit"} value={option.id}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}

function ApiJsonAdvancedFields({
  apiCustomHeadersJson,
  apiExtraBodyJson,
  clearTestState,
  controlsBusy,
  setApiCustomHeadersJson,
  setApiExtraBodyJson,
}: ApiSettingsFieldsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <label>
        {t("settings.api.advanced.extraBody")}
        <textarea
          className="settings-json-textarea"
          value={apiExtraBodyJson}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setApiExtraBodyJson(event.target.value);
          }}
          placeholder={
            '{"provider":{"sort":"throughput"}}\n{"extra_body":{"google":{"thinking_config":{"thinking_level":"low"}}}}\n{"chat_template_kwargs":{"enable_thinking":false}}'
          }
          spellCheck={false}
        />
      </label>
      <label>
        {t("settings.api.advanced.customHeaders")}
        <textarea
          className="settings-json-textarea"
          value={apiCustomHeadersJson}
          disabled={controlsBusy}
          onChange={(event) => {
            clearTestState();
            setApiCustomHeadersJson(event.target.value);
          }}
          placeholder='{"HTTP-Referer":"https://example.invalid","X-OpenRouter-Title":"Manga Translator"}'
          spellCheck={false}
        />
      </label>
    </>
  );
}
