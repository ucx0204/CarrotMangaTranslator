import React from "react";
import { parseApiKeys } from "../../../../shared/apiKeySettings";
import {
  inferApiProviderPreset,
  inferVertexSettings,
  resolveApiProviderBaseUrl,
  type ApiModelOption,
  type ApiProviderPresetId,
  type DiscoverableApiProviderId,
} from "../../../../shared/apiProviderPresets";
import type { EngineSettingsPanelProps } from "./EngineSettingsPanelTypes";
import { settingsGateway } from "../../api/settingsGateway";
import { useMountedRef } from "../../hooks/useMountedRef";

export type ApiProviderConnectionProps = Pick<
  EngineSettingsPanelProps,
  | "apiBaseUrl"
  | "apiKey"
  | "apiVertexAuthMode"
  | "apiVertexServiceAccountPath"
  | "apiKeyMaxAttempts"
  | "apiModel"
  | "apiRetryDelaySeconds"
  | "clearTestState"
  | "controlsBusy"
  | "setApiBaseUrl"
  | "setApiKey"
  | "setApiVertexAuthMode"
  | "setApiVertexServiceAccountPath"
  | "setApiKeyMaxAttempts"
  | "setApiModel"
  | "setApiRetryDelaySeconds"
  | "submit"
>;

export type DiscoveryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; checkedCount: number; unverifiedCount: number }
  | { status: "error"; message: string };

type DiscoveryController = {
  discovery: DiscoveryState;
  models: ApiModelOption[];
  invalidate: () => void;
  load: (
    provider: DiscoverableApiProviderId,
    apiKey: string,
    vertexAuthMode: ApiProviderConnectionProps["apiVertexAuthMode"],
    vertexServiceAccountPath: string,
    vertexProject: string,
    vertexLocation: string,
  ) => Promise<void>;
  reportError: (error: unknown) => void;
};

export function useApiProviderConnection(props: ApiProviderConnectionProps) {
  const [provider, setProvider] = React.useState<ApiProviderPresetId>(() =>
    inferApiProviderPreset(props.apiBaseUrl),
  );
  const [vertexProject, setVertexProject] = React.useState(
    () => inferVertexSettings(props.apiBaseUrl).project,
  );
  const [vertexLocation, setVertexLocation] = React.useState(
    () => inferVertexSettings(props.apiBaseUrl).location,
  );
  const [showApiKey, setShowApiKey] = React.useState(false);
  const modelDiscovery = useModelDiscovery();
  const updateBaseUrl = useExternalBaseUrlSync({
    baseUrl: props.apiBaseUrl,
    invalidate: modelDiscovery.invalidate,
    setBaseUrl: props.setApiBaseUrl,
    setProvider,
    setVertexLocation,
    setVertexProject,
  });
  const { applyProvider, updateVertex } = createProviderSelectionActions({
    clearTestState: props.clearTestState,
    invalidate: modelDiscovery.invalidate,
    setProvider,
    setVertexLocation,
    setVertexProject,
    updateBaseUrl,
    vertexLocation,
    vertexProject,
  });
  const vertexCredentials = useVertexCredentialController(
    props,
    modelDiscovery,
    updateVertex,
    vertexLocation,
  );

  const isDiscoverable = provider !== "custom";
  const loadModels = async (): Promise<void> => {
    if (provider === "custom") return;
    await modelDiscovery.load(
      provider,
      props.apiKey,
      props.apiVertexAuthMode,
      props.apiVertexServiceAccountPath,
      vertexProject,
      vertexLocation,
    );
  };

  return {
    ...modelDiscovery,
    ...vertexCredentials,
    applyProvider,
    isDiscoverable,
    keyCount: parseApiKeys(props.apiKey).length,
    loadModels,
    openProviderPage: () =>
      openProviderPage(provider, modelDiscovery.reportError),
    provider,
    setShowApiKey,
    showApiKey,
    updateVertex,
    vertexLocation,
    vertexProject,
    vertexReady:
      provider !== "google-vertex" ||
      (Boolean(
        resolveApiProviderBaseUrl({ provider, vertexProject, vertexLocation }),
      ) &&
        (props.apiVertexAuthMode !== "service-account" ||
          Boolean(props.apiVertexServiceAccountPath.trim()))),
  };
}

function createProviderSelectionActions({
  clearTestState,
  invalidate,
  setProvider,
  setVertexLocation,
  setVertexProject,
  updateBaseUrl,
  vertexLocation,
  vertexProject,
}: {
  clearTestState: () => void;
  invalidate: () => void;
  setProvider: React.Dispatch<React.SetStateAction<ApiProviderPresetId>>;
  setVertexLocation: React.Dispatch<React.SetStateAction<string>>;
  setVertexProject: React.Dispatch<React.SetStateAction<string>>;
  updateBaseUrl: (value: string) => void;
  vertexLocation: string;
  vertexProject: string;
}) {
  const applyProvider = (nextProvider: ApiProviderPresetId): void => {
    setProvider(nextProvider);
    invalidate();
    clearTestState();
    const baseUrl = resolveApiProviderBaseUrl({
      provider: nextProvider,
      vertexProject,
      vertexLocation,
    });
    if (baseUrl) updateBaseUrl(baseUrl);
    else if (nextProvider === "google-vertex") updateBaseUrl("");
  };
  const updateVertex = (project: string, location: string): void => {
    setVertexProject(project);
    setVertexLocation(location);
    invalidate();
    clearTestState();
    const baseUrl = resolveApiProviderBaseUrl({
      provider: "google-vertex",
      vertexProject: project,
      vertexLocation: location,
    });
    updateBaseUrl(baseUrl ?? "");
  };
  return { applyProvider, updateVertex };
}

function useVertexCredentialController(
  props: ApiProviderConnectionProps,
  discovery: DiscoveryController,
  updateVertex: (project: string, location: string) => void,
  vertexLocation: string,
) {
  const [credentialBusy, setCredentialBusy] = React.useState(false);
  const [credentialError, setCredentialError] = React.useState<string | null>(
    null,
  );
  const updateVertexAuthMode = (
    nextMode: ApiProviderConnectionProps["apiVertexAuthMode"],
  ): void => {
    props.clearTestState();
    props.setApiVertexAuthMode(nextMode);
    setCredentialError(null);
    discovery.invalidate();
  };
  const pickVertexServiceAccount = async (): Promise<void> => {
    setCredentialBusy(true);
    setCredentialError(null);
    try {
      const picked = await settingsGateway.pickVertexServiceAccountFile();
      if (!picked) return;
      props.clearTestState();
      props.setApiVertexAuthMode("service-account");
      props.setApiVertexServiceAccountPath(picked.filePath);
      updateVertex(picked.projectId, vertexLocation);
    } catch (error) {
      setCredentialError(readErrorMessage(error));
    } finally {
      setCredentialBusy(false);
    }
  };
  const clearVertexServiceAccount = (): void => {
    props.clearTestState();
    props.setApiVertexServiceAccountPath("");
    setCredentialError(null);
    discovery.invalidate();
  };
  return {
    clearVertexServiceAccount,
    credentialBusy,
    credentialError,
    pickVertexServiceAccount,
    updateVertexAuthMode,
  };
}

async function openProviderPage(
  provider: ApiProviderPresetId,
  reportError: (error: unknown) => void,
): Promise<void> {
  if (provider === "custom") return;
  try {
    await settingsGateway.openApiProviderPage(provider);
  } catch (error) {
    reportError(error);
  }
}

export type ApiProviderConnectionState = ReturnType<
  typeof useApiProviderConnection
>;

function useExternalBaseUrlSync({
  baseUrl,
  invalidate,
  setBaseUrl,
  setProvider,
  setVertexLocation,
  setVertexProject,
}: {
  baseUrl: string;
  invalidate: () => void;
  setBaseUrl: (value: string) => void;
  setProvider: React.Dispatch<React.SetStateAction<ApiProviderPresetId>>;
  setVertexLocation: React.Dispatch<React.SetStateAction<string>>;
  setVertexProject: React.Dispatch<React.SetStateAction<string>>;
}): (value: string) => void {
  const observedBaseUrl = React.useRef(baseUrl);
  const pendingBaseUrl = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (observedBaseUrl.current === baseUrl) return;
    observedBaseUrl.current = baseUrl;
    if (pendingBaseUrl.current === baseUrl) {
      pendingBaseUrl.current = null;
      return;
    }
    pendingBaseUrl.current = null;
    const nextVertex = inferVertexSettings(baseUrl);
    setProvider(inferApiProviderPreset(baseUrl));
    setVertexProject(nextVertex.project);
    setVertexLocation(nextVertex.location);
    invalidate();
  }, [baseUrl, invalidate, setProvider, setVertexLocation, setVertexProject]);
  return React.useCallback(
    (value: string) => {
      pendingBaseUrl.current = value;
      setBaseUrl(value);
    },
    [setBaseUrl],
  );
}

function useModelDiscovery(): DiscoveryController {
  const [models, setModels] = React.useState<ApiModelOption[]>([]);
  const [discovery, setDiscovery] = React.useState<DiscoveryState>({
    status: "idle",
  });
  const requestSequence = React.useRef(0);
  const activeRef = useMountedRef();
  React.useEffect(
    () => () => {
      requestSequence.current += 1;
    },
    [],
  );
  const invalidate = React.useCallback((): void => {
    requestSequence.current += 1;
    setModels([]);
    setDiscovery({ status: "idle" });
  }, []);
  const reportError = React.useCallback(
    (error: unknown): void => {
      if (activeRef.current) {
        setDiscovery({ status: "error", message: readErrorMessage(error) });
      }
    },
    [activeRef],
  );
  const load: DiscoveryController["load"] = React.useCallback(
    async (
      provider,
      apiKey,
      vertexAuthMode,
      vertexServiceAccountPath,
      vertexProject,
      vertexLocation,
    ) => {
      if (!activeRef.current) {
        return;
      }
      const sequence = ++requestSequence.current;
      setDiscovery({ status: "loading" });
      try {
        const result = await settingsGateway.discoverApiModels({
          provider,
          apiKey,
          ...(provider === "google-vertex"
            ? {
                vertexAuthMode,
                vertexServiceAccountPath,
                vertexProject,
                vertexLocation,
              }
            : {}),
        });
        if (!activeRef.current || requestSequence.current !== sequence) return;
        setModels(result.models);
        setDiscovery({
          status: "success",
          checkedCount: result.checkedCount,
          unverifiedCount: result.unverifiedCount,
        });
      } catch (error) {
        if (!activeRef.current || requestSequence.current !== sequence) return;
        setModels([]);
        reportError(error);
      }
    },
    [activeRef, reportError],
  );
  return { discovery, models, invalidate, load, reportError };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
