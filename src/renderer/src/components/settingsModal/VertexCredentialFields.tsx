import React from "react";
import { useTranslation } from "react-i18next";
import { MAX_API_KEYS_TEXT_LENGTH } from "../../../../shared/apiKeySettings";
import type {
  ApiProviderConnectionProps,
  ApiProviderConnectionState,
} from "./useApiProviderConnection";
import { ApiKeyVisibilityButton } from "./ApiKeyVisibilityButton";
import { VertexServiceAccountGuideModal } from "./VertexServiceAccountGuideModal";

type VertexCredentialFieldsProps = Pick<
  ApiProviderConnectionProps,
  | "apiKey"
  | "apiVertexAuthMode"
  | "apiVertexServiceAccountPath"
  | "clearTestState"
  | "controlsBusy"
  | "setApiKey"
> & { connection: ApiProviderConnectionState };

export function VertexCredentialFields({
  apiKey,
  apiVertexAuthMode,
  apiVertexServiceAccountPath,
  clearTestState,
  connection,
  controlsBusy,
  setApiKey,
}: VertexCredentialFieldsProps): React.JSX.Element {
  const { t } = useTranslation("components");
  const [guideOpen, setGuideOpen] = React.useState(false);
  const disabled =
    controlsBusy ||
    connection.credentialBusy ||
    connection.discovery.status === "loading";
  return (
    <>
      <div className="settings-field-stack">
        <span>{t("settings.api.vertexAuthMode")}</span>
        <div
          className="settings-mode-group"
          role="group"
          aria-label={t("settings.api.vertexAuthMode")}
        >
          {(["access-token", "service-account"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`settings-preset-button ${apiVertexAuthMode === mode ? "active" : ""}`}
              aria-pressed={apiVertexAuthMode === mode}
              disabled={disabled}
              onClick={() => connection.updateVertexAuthMode(mode)}
            >
              {t(
                mode === "access-token"
                  ? "settings.api.vertexAuthAccessToken"
                  : "settings.api.vertexAuthServiceAccount",
              )}
            </button>
          ))}
        </div>
      </div>
      {apiVertexAuthMode === "service-account" ? (
        <ServiceAccountCredential
          filePath={apiVertexServiceAccountPath}
          connection={connection}
          disabled={disabled}
        />
      ) : (
        <AccessTokenCredential
          apiKey={apiKey}
          clearTestState={clearTestState}
          connection={connection}
          disabled={disabled}
          setApiKey={setApiKey}
        />
      )}
      <button
        type="button"
        className="settings-external-link"
        disabled={controlsBusy}
        onClick={() => {
          if (apiVertexAuthMode === "service-account") {
            setGuideOpen(true);
            return;
          }
          void connection.openProviderPage();
        }}
      >
        {t("settings.api.openVertexAuth")}
      </button>
      {guideOpen ? (
        <VertexServiceAccountGuideModal onClose={() => setGuideOpen(false)} />
      ) : null}
    </>
  );
}

function AccessTokenCredential({
  apiKey,
  clearTestState,
  connection,
  disabled,
  setApiKey,
}: {
  apiKey: string;
  clearTestState: () => void;
  connection: ApiProviderConnectionState;
  disabled: boolean;
  setApiKey: React.Dispatch<React.SetStateAction<string>>;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      <label>
        {t("settings.api.vertexAccessToken")}
        <div className="settings-api-key-shell">
          <textarea
            className={`settings-api-key-textarea ${connection.showApiKey ? "" : "masked"}`}
            value={apiKey}
            disabled={disabled}
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
              controlsBusy={disabled}
              setShowApiKey={connection.setShowApiKey}
              showApiKey={connection.showApiKey}
            />
          </span>
        </div>
      </label>
      <p className="muted-line modal-note">
        {t("settings.api.keyDescription", { count: connection.keyCount })}
      </p>
    </>
  );
}

function ServiceAccountCredential({
  connection,
  disabled,
  filePath,
}: {
  connection: ApiProviderConnectionState;
  disabled: boolean;
  filePath: string;
}): React.JSX.Element {
  const { t } = useTranslation("components");
  const fileName = filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return (
    <div className="settings-field-stack">
      <div className="settings-limit-toolbar">
        <div className="settings-limit-recommendation">
          <strong>
            {fileName || t("settings.api.vertexServiceAccountNotSelected")}
          </strong>
          {filePath ? (
            <small title={filePath} dir="ltr">
              {filePath}
            </small>
          ) : null}
        </div>
        <div className="inline-actions">
          <button
            type="button"
            disabled={disabled}
            onClick={() => void connection.pickVertexServiceAccount()}
          >
            {t(
              filePath
                ? "settings.api.vertexServiceAccountChange"
                : "settings.api.vertexServiceAccountSelect",
            )}
          </button>
          {filePath ? (
            <button
              type="button"
              disabled={disabled}
              onClick={connection.clearVertexServiceAccount}
            >
              {t("settings.api.vertexServiceAccountClear")}
            </button>
          ) : null}
        </div>
      </div>
      {connection.credentialError ? (
        <p className="settings-api-status error" role="alert">
          {connection.credentialError}
        </p>
      ) : null}
      <p className="muted-line modal-note">
        {t("settings.api.vertexServiceAccountDescription")}
      </p>
    </div>
  );
}
