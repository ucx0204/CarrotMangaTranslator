export const API_PROVIDER_PRESET_IDS = [
  "custom",
  "nvidia-nim",
  "google-ai-studio",
  "google-vertex",
  "openrouter",
  "ollama",
] as const;

export type ApiProviderPresetId = (typeof API_PROVIDER_PRESET_IDS)[number];
export type DiscoverableApiProviderId = Exclude<ApiProviderPresetId, "custom">;

export type ApiModelDiscoveryRequest = {
  provider: DiscoverableApiProviderId;
  apiKey: string;
  vertexProject?: string;
  vertexLocation?: string;
};

export type ApiModelOption = {
  id: string;
  label: string;
  baseUrl: string;
};

export type ApiModelDiscoveryResult = {
  provider: DiscoverableApiProviderId;
  models: ApiModelOption[];
  checkedCount: number;
  unverifiedCount: number;
};

export const NVIDIA_NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const GOOGLE_AI_STUDIO_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";
const DEFAULT_VERTEX_LOCATION = "global";

export function buildVertexOpenAiBaseUrl(
  project: string,
  location = DEFAULT_VERTEX_LOCATION,
): string | null {
  const normalizedProject = project.trim();
  const normalizedLocation = location.trim().toLowerCase();
  if (
    !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/i.test(normalizedProject) ||
    !/^(global|[a-z]+-[a-z]+\d+)$/i.test(normalizedLocation)
  ) {
    return null;
  }
  const host =
    normalizedLocation === "global"
      ? "aiplatform.googleapis.com"
      : `${normalizedLocation}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${normalizedProject}/locations/${normalizedLocation}/endpoints/openapi`;
}

export function resolveApiProviderBaseUrl({
  provider,
  vertexProject = "",
  vertexLocation = DEFAULT_VERTEX_LOCATION,
}: {
  provider: ApiProviderPresetId;
  vertexProject?: string;
  vertexLocation?: string;
}): string | null {
  if (provider === "nvidia-nim") {
    return NVIDIA_NIM_BASE_URL;
  }
  if (provider === "google-ai-studio") {
    return GOOGLE_AI_STUDIO_BASE_URL;
  }
  if (provider === "google-vertex") {
    return buildVertexOpenAiBaseUrl(vertexProject, vertexLocation);
  }
  if (provider === "openrouter") {
    return OPENROUTER_BASE_URL;
  }
  if (provider === "ollama") {
    return OLLAMA_BASE_URL;
  }
  return null;
}

export function inferApiProviderPreset(baseUrl: string): ApiProviderPresetId {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (_error) {
    return "custom";
  }
  if (url.hostname === "integrate.api.nvidia.com") {
    return "nvidia-nim";
  }
  if (url.hostname === "generativelanguage.googleapis.com") {
    return "google-ai-studio";
  }
  if (
    url.hostname === "aiplatform.googleapis.com" ||
    url.hostname.endsWith("-aiplatform.googleapis.com")
  ) {
    return "google-vertex";
  }
  if (url.hostname === "openrouter.ai") {
    return "openrouter";
  }
  // Ollama 기본 포트. localhost/127.0.0.1/LAN 호스트 모두 포괄.
  if (url.port === "11434") {
    return "ollama";
  }
  return "custom";
}

export function inferVertexSettings(baseUrl: string): {
  project: string;
  location: string;
} {
  const match = baseUrl.match(
    /\/projects\/([^/]+)\/locations\/([^/]+)\/endpoints\/openapi/i,
  );
  return {
    project: match?.[1] ?? "",
    location: match?.[2] ?? DEFAULT_VERTEX_LOCATION,
  };
}
