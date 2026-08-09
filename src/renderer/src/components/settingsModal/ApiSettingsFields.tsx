import React from "react";
import { useTranslation } from "react-i18next";
import type { ApiReasoningEffort } from "../../../../shared/settingsTypes";
import { API_REASONING_OPTIONS } from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { ApiProviderConnectionFields } from "./ApiProviderConnectionFields";
import { Select } from "../ui/Select";

export type ApiSettingsFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "apiBaseUrl"
  | "apiCustomHeadersJson"
  | "apiExtraBodyJson"
  | "apiKey"
  | "apiKeyMaxAttempts"
  | "apiRetryDelaySeconds"
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
  | "setApiKeyMaxAttempts"
  | "setApiRetryDelaySeconds"
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
  return (
    <>
      <ApiProviderConnectionFields {...props} />
      <ApiAdvancedRequestFields {...props} />
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
      <Select
        ariaLabel={t("settings.api.advanced.reasoningEffort")}
        value={apiReasoningEffort}
        disabled={controlsBusy}
        options={API_REASONING_OPTIONS.map((option) => ({
          value: option.id,
          label: t(option.labelKey),
        }))}
        onValueChange={(nextValue) => {
          clearTestState();
          setApiReasoningEffort(nextValue as ApiReasoningEffort | "");
        }}
      />
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
