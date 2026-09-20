import React from "react";
import { ControlTooltip } from "../ui/ControlTooltip";
import { useTranslation } from "react-i18next";
import type { ApiReasoningEffort } from "../../../../shared/settingsTypes";
import { API_REASONING_OPTIONS } from "../settingsOptions";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { ApiProviderConnectionFields } from "./ApiProviderConnectionFields";
import { SettingsNumberField } from "./SettingsNumberField";
import { Field } from "../ui/Field";
import { Select } from "../ui/Select";

export type ApiSettingsFieldsProps = Pick<
  EngineSettingsPanelProps,
  | "apiBaseUrl"
  | "apiProvider"
  | "apiCustomHeadersJson"
  | "apiExtraBodyJson"
  | "apiKey"
  | "apiKeyCount"
  | "apiVertexAuthMode"
  | "apiVertexServiceAccountPath"
  | "apiKeyMaxAttempts"
  | "apiRetryDelaySeconds"
  | "apiRequestIntervalSeconds"
  | "apiModel"
  | "apiReasoningEffort"
  | "apiTemperature"
  | "apiTopK"
  | "apiTopP"
  | "clearTestState"
  | "controlsBusy"
  | "setApiBaseUrl"
  | "setApiProvider"
  | "setApiCustomHeadersJson"
  | "setApiExtraBodyJson"
  | "setApiKey"
  | "setApiVertexAuthMode"
  | "setApiVertexServiceAccountPath"
  | "setApiKeyMaxAttempts"
  | "setApiRetryDelaySeconds"
  | "setApiRequestIntervalSeconds"
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
  return (
    <div className="settings-subsection-stack">
      <ApiScalarAdvancedFields {...props} />
      <ApiJsonAdvancedFields {...props} />
    </div>
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
  // Blank means "leave it to the provider default", so all three stay optional.
  return (
    <div className="settings-advanced-grid">
      <SettingsNumberField
        ariaLabel={t("settings.api.advanced.temperature")}
        tooltip={t("settings.api.advanced.help.temperature")}
        optional
        min={0}
        max={2}
        step={0.05}
        precision={2}
        value={apiTemperature}
        disabled={controlsBusy}
        onValueChange={(next) => {
          clearTestState();
          setApiTemperature(next);
        }}
      />
      <SettingsNumberField
        ariaLabel={t("settings.api.advanced.topP")}
        tooltip={t("settings.api.advanced.help.topP")}
        optional
        min={0}
        max={1}
        step={0.01}
        precision={2}
        value={apiTopP}
        disabled={controlsBusy}
        onValueChange={(next) => {
          clearTestState();
          setApiTopP(next);
        }}
      />
      <SettingsNumberField
        ariaLabel={t("settings.api.advanced.topK")}
        tooltip={t("settings.api.advanced.help.topK")}
        optional
        min={1}
        max={1000}
        step={1}
        value={apiTopK}
        disabled={controlsBusy}
        onValueChange={(next) => {
          clearTestState();
          setApiTopK(next);
        }}
      />
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
    <Field
      label={t("settings.api.advanced.reasoningEffort")}
      density="comfortable"
    >
      <ControlTooltip
        floating
        content={t("settings.api.advanced.help.reasoningEffort")}
      >
        {(descriptionId) => (
          <Select
            ariaDescribedBy={descriptionId}
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
        )}
      </ControlTooltip>
    </Field>
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
        <ControlTooltip
          floating
          content={t("settings.api.advanced.help.extraBody")}
        >
          <textarea
            className="settings-json-textarea"
            aria-label={t("settings.api.advanced.extraBody")}
            value={apiExtraBodyJson}
            disabled={controlsBusy}
            onChange={(event) => {
              clearTestState();
              setApiExtraBodyJson(event.target.value);
            }}
            placeholder="{}"
            spellCheck={false}
          />
        </ControlTooltip>
      </label>
      <label>
        {t("settings.api.advanced.customHeaders")}
        <ControlTooltip
          floating
          content={t("settings.api.advanced.help.customHeaders")}
        >
          <textarea
            className="settings-json-textarea"
            aria-label={t("settings.api.advanced.customHeaders")}
            value={apiCustomHeadersJson}
            disabled={controlsBusy}
            onChange={(event) => {
              clearTestState();
              setApiCustomHeadersJson(event.target.value);
            }}
            placeholder="{}"
            spellCheck={false}
          />
        </ControlTooltip>
      </label>
    </>
  );
}
