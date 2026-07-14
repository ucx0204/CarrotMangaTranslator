import React from "react";
import { useTranslation } from "react-i18next";
import {
  MAX_API_KEY_MAX_ATTEMPTS,
  MAX_API_KEYS_TEXT_LENGTH,
  MAX_API_RETRY_DELAY_SECONDS,
  MIN_API_KEY_MAX_ATTEMPTS,
  MIN_API_RETRY_DELAY_SECONDS,
} from "../../../../shared/apiKeySettings";
import {
  API_PROVIDER_PRESET_IDS,
  type ApiProviderPresetId,
} from "../../../../shared/apiProviderPresets";
import { IconButton } from "../ui/IconButton";
import { EyeIcon, EyeOffIcon } from "../ui/icons";
import { ApiProviderModelFields } from "./ApiProviderModelFields";
import {
  useApiProviderConnection,
  type ApiProviderConnectionProps,
  type ApiProviderConnectionState,
  type DiscoveryState,
} from "./useApiProviderConnection";

const PROVIDER_LABEL_KEYS: Record<ApiProviderPresetId, string> = {
  custom: "settings.api.providers.custom",
  "nvidia-nim": "settings.api.providers.nvidiaNim",
  "google-ai-studio": "settings.api.providers.googleAiStudio",
  "google-vertex": "settings.api.providers.googleVertex",
  openrouter: "settings.api.providers.openRouter",
};

export function ApiProviderConnectionFields(
  props: ApiProviderConnectionProps,
): React.JSX.Element {
  const { t } = useTranslation("components");
  const connection = useApiProviderConnection(props);
  return (
    <div className="settings-api-stack">
      <ApiSubsection title={t("settings.api.sections.connection")}>
        <ProviderTemplateFields {...props} connection={connection} />
        <BaseUrlField {...props} discovery={connection.discovery} />
      </ApiSubsection>
      <ApiSubsection title={t("settings.api.sections.credentials")}>
        <CredentialFields {...props} connection={connection} />
      </ApiSubsection>
      <ApiSubsection title={t("settings.api.sections.model")}>
        <ApiProviderModelFields {...props} connection={connection} />
      </ApiSubsection>
      <ApiSubsection title={t("settings.api.sections.retry")}>
        <RetryFields {...props} />
      </ApiSubsection>
    </div>
  );
}

function ApiSubsection({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}): React.JSX.Element {
  return (
    <section className="settings-subsection">
      <h4>{title}</h4>
      <div className="settings-subsection-body">{children}</div>
    </section>
  );
}

function ProviderTemplateFields({
  connection,
  controlsBusy,
}: ApiProviderConnectionProps & {
  connection: ApiProviderConnectionState;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const busy = controlsBusy || connection.discovery.status === "loading";
  return (
    <>
      <div className="settings-api-template">
        <label>
          {t("settings.api.providerTemplate")}
          <select
            value={connection.provider}
            disabled={busy}
            onChange={(event) =>
              connection.applyProvider(
                event.target.value as ApiProviderPresetId,
              )
            }
          >
            {API_PROVIDER_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {t(PROVIDER_LABEL_KEYS[id])}
              </option>
            ))}
          </select>
        </label>
        <p className="muted-line modal-note">
          {t(
            connection.provider === "custom"
              ? "settings.api.providerHintCustom"
              : "settings.api.providerHintVerified",
          )}
        </p>
      </div>
      {connection.provider === "google-vertex" ? (
        <VertexFields connection={connection} controlsBusy={controlsBusy} />
      ) : null}
    </>
  );
}

function VertexFields({
  connection,
  controlsBusy,
}: {
  connection: ApiProviderConnectionState;
  controlsBusy: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const disabled = controlsBusy || connection.discovery.status === "loading";
  return (
    <div className="settings-advanced-grid">
      <label>
        {t("settings.api.vertexProject")}
        <input
          value={connection.vertexProject}
          disabled={disabled}
          placeholder="my-gcp-project"
          onChange={(event) =>
            connection.updateVertex(
              event.target.value,
              connection.vertexLocation,
            )
          }
        />
      </label>
      <label>
        {t("settings.api.vertexLocation")}
        <input
          value={connection.vertexLocation}
          disabled={disabled}
          placeholder="global"
          onChange={(event) =>
            connection.updateVertex(
              connection.vertexProject,
              event.target.value,
            )
          }
        />
      </label>
    </div>
  );
}

function BaseUrlField({
  apiBaseUrl,
  clearTestState,
  controlsBusy,
  discovery,
  setApiBaseUrl,
  submit,
}: Pick<
  ApiProviderConnectionProps,
  "apiBaseUrl" | "clearTestState" | "controlsBusy" | "setApiBaseUrl" | "submit"
> & { discovery: DiscoveryState }): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <label>
      {t("settings.api.baseUrl")}
      <input
        value={apiBaseUrl}
        disabled={controlsBusy || discovery.status === "loading"}
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
  );
}

function CredentialFields({
  apiKey,
  clearTestState,
  connection,
  controlsBusy,
  setApiKey,
}: Pick<
  ApiProviderConnectionProps,
  "apiKey" | "clearTestState" | "controlsBusy" | "setApiKey"
> & { connection: ApiProviderConnectionState }): React.JSX.Element {
  const { t } = useTranslation("components");
  const keyLabel =
    connection.provider === "google-vertex"
      ? "settings.api.vertexAccessToken"
      : "settings.api.key";
  const linkLabel =
    connection.provider === "google-vertex"
      ? "settings.api.openVertexAuth"
      : "settings.api.openKeyPage";
  return (
    <>
      <label>
        {t(keyLabel)}
        <div className="settings-api-key-shell">
          <textarea
            className={`settings-api-key-textarea ${connection.showApiKey ? "" : "masked"}`}
            value={apiKey}
            disabled={controlsBusy || connection.discovery.status === "loading"}
            onChange={(event) => {
              clearTestState();
              setApiKey(event.target.value);
            }}
            placeholder={t("settings.api.keyPlaceholder")}
            rows={3}
            maxLength={MAX_API_KEYS_TEXT_LENGTH}
            spellCheck={false}
            autoComplete="off"
          />
          <span className="settings-api-key-action">
            <ApiKeyVisibilityButton
              connection={connection}
              controlsBusy={controlsBusy}
            />
          </span>
        </div>
      </label>
      <p className="muted-line modal-note">
        {t("settings.api.keyDescription", { count: connection.keyCount })}
      </p>
      {connection.isDiscoverable ? (
        <button
          type="button"
          className="settings-external-link"
          disabled={controlsBusy}
          onClick={() => void connection.openProviderPage()}
        >
          {t(linkLabel)}
        </button>
      ) : null}
    </>
  );
}

function ApiKeyVisibilityButton({
  connection,
  controlsBusy,
}: {
  connection: ApiProviderConnectionState;
  controlsBusy: boolean;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <IconButton
      label={
        connection.showApiKey
          ? t("settings.api.hideKey")
          : t("settings.api.showKey")
      }
      aria-pressed={connection.showApiKey}
      disabled={controlsBusy}
      onClick={() => connection.setShowApiKey(!connection.showApiKey)}
    >
      {connection.showApiKey ? <EyeOffIcon /> : <EyeIcon />}
    </IconButton>
  );
}

function RetryFields({
  apiKeyMaxAttempts,
  apiRetryDelaySeconds,
  clearTestState,
  controlsBusy,
  setApiKeyMaxAttempts,
  setApiRetryDelaySeconds,
}: Pick<
  ApiProviderConnectionProps,
  | "apiKeyMaxAttempts"
  | "apiRetryDelaySeconds"
  | "clearTestState"
  | "controlsBusy"
  | "setApiKeyMaxAttempts"
  | "setApiRetryDelaySeconds"
>): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <div className="settings-advanced-grid">
        <label>
          {t("settings.api.keyMaxAttempts")}
          <input
            type="number"
            min={MIN_API_KEY_MAX_ATTEMPTS}
            max={MAX_API_KEY_MAX_ATTEMPTS}
            step={1}
            value={apiKeyMaxAttempts}
            disabled={controlsBusy}
            onChange={(event) => {
              clearTestState();
              setApiKeyMaxAttempts(event.target.value);
            }}
          />
        </label>
        <label>
          {t("settings.api.retryDelaySeconds")}
          <input
            type="number"
            min={MIN_API_RETRY_DELAY_SECONDS}
            max={MAX_API_RETRY_DELAY_SECONDS}
            step={0.5}
            value={apiRetryDelaySeconds}
            disabled={controlsBusy}
            onChange={(event) => {
              clearTestState();
              setApiRetryDelaySeconds(event.target.value);
            }}
          />
        </label>
      </div>
      <p className="muted-line modal-note">
        {t("settings.api.retryDescription")}
      </p>
    </>
  );
}
