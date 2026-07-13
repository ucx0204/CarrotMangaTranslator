import React from "react";
import { useTranslation } from "react-i18next";
import type { ApiModelOption } from "../../../../shared/apiProviderPresets";
import type {
  ApiProviderConnectionProps,
  ApiProviderConnectionState,
  DiscoveryState,
} from "./useApiProviderConnection";

type ModelFieldProps = Pick<
  ApiProviderConnectionProps,
  | "apiModel"
  | "clearTestState"
  | "controlsBusy"
  | "setApiBaseUrl"
  | "setApiModel"
  | "submit"
> & { connection: ApiProviderConnectionState };

export function ApiProviderModelFields({
  apiModel,
  clearTestState,
  connection,
  controlsBusy,
  setApiBaseUrl,
  setApiModel,
  submit,
}: ModelFieldProps): React.JSX.Element {
  const { t } = useTranslation("components");
  return (
    <>
      {connection.isDiscoverable ? (
        <ModelDiscoveryFields
          apiModel={apiModel}
          clearTestState={clearTestState}
          connection={connection}
          controlsBusy={controlsBusy}
          setApiBaseUrl={setApiBaseUrl}
          setApiModel={setApiModel}
        />
      ) : null}
      <DiscoveryMessage
        discovery={connection.discovery}
        models={connection.models}
      />
      <label>
        {t("settings.api.model")}
        <input
          value={apiModel}
          disabled={controlsBusy || connection.discovery.status === "loading"}
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
    </>
  );
}

function ModelDiscoveryFields({
  apiModel,
  clearTestState,
  connection,
  controlsBusy,
  setApiBaseUrl,
  setApiModel,
}: Omit<ModelFieldProps, "submit">): React.JSX.Element {
  const { t } = useTranslation("components");
  const selected = connection.models.some((model) => model.id === apiModel)
    ? apiModel
    : "";
  const selectModel = (modelId: string): void => {
    const model = connection.models.find((item) => item.id === modelId);
    if (!model) return;
    clearTestState();
    setApiBaseUrl(model.baseUrl);
    setApiModel(model.id);
  };
  return (
    <div className="settings-model-discovery-row">
      <label>
        {t("settings.api.discoveredModel")}
        <select
          value={selected}
          disabled={
            controlsBusy ||
            connection.discovery.status === "loading" ||
            !connection.models.length
          }
          onChange={(event) => selectModel(event.target.value)}
        >
          <option value="">{t("settings.api.chooseModel")}</option>
          {connection.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label} · {model.id}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={
          controlsBusy ||
          connection.discovery.status === "loading" ||
          !connection.vertexReady
        }
        onClick={() => void connection.loadModels()}
      >
        {t(
          connection.discovery.status === "loading"
            ? "settings.api.loadingModels"
            : "settings.api.loadModels",
        )}
      </button>
    </div>
  );
}

function DiscoveryMessage({
  discovery,
  models,
}: {
  discovery: DiscoveryState;
  models: ApiModelOption[];
}): React.JSX.Element | null {
  const { t } = useTranslation("components");
  if (discovery.status === "error") {
    return (
      <p className="settings-api-status error" role="alert">
        {t("settings.api.modelLoadError", { message: discovery.message })}
      </p>
    );
  }
  if (discovery.status !== "success") return null;
  return (
    <p className="settings-api-status" role="status">
      {t("settings.api.modelLoadSuccess", {
        count: models.length,
        checked: discovery.checkedCount,
        excluded: discovery.unverifiedCount,
      })}
    </p>
  );
}
