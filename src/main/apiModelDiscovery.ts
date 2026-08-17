import type {
  ApiModelDiscoveryRequest,
  ApiModelDiscoveryResult,
} from "../shared/apiProviderPresets";
import {
  discoverNvidiaNimModels,
  discoverOllamaModels,
  discoverOpenRouterModels,
} from "./apiModelDiscoveryCatalogs";
import type { FetchLike } from "./apiModelDiscoveryCommon";
import {
  discoverGoogleAiStudioModels,
  discoverGoogleVertexModels,
} from "./apiModelDiscoveryGoogle";
import { getVertexServiceAccountAccessToken } from "./vertexServiceAccountAuth";

type VertexTokenResolver = (
  filePath: string,
  request?: { forceRefresh?: boolean },
) => Promise<string>;

export async function discoverApiModels(
  request: ApiModelDiscoveryRequest,
  fetchImpl: FetchLike = fetch,
  resolveVertexToken: VertexTokenResolver = getVertexServiceAccountAccessToken,
): Promise<ApiModelDiscoveryResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(new Error("모델 검색 제한 시간(60초)을 초과했습니다.")),
    60_000,
  );
  const deadlineFetch: FetchLike = (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal,
    });
  try {
    const effectiveRequest = await resolveDiscoveryCredentials(
      request,
      resolveVertexToken,
    );
    const result = await dispatchApiModelDiscovery(
      effectiveRequest,
      deadlineFetch,
    );
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveDiscoveryCredentials(
  request: ApiModelDiscoveryRequest,
  resolveVertexToken: VertexTokenResolver,
): Promise<ApiModelDiscoveryRequest> {
  if (
    request.provider !== "google-vertex" ||
    request.vertexAuthMode !== "service-account"
  ) {
    return request;
  }
  const filePath = request.vertexServiceAccountPath?.trim();
  if (!filePath) {
    throw new Error("Vertex 서비스 계정 JSON 파일을 선택해 주세요.");
  }
  return {
    ...request,
    apiKey: await resolveVertexToken(filePath),
  };
}

function dispatchApiModelDiscovery(
  request: ApiModelDiscoveryRequest,
  fetchImpl: FetchLike,
): Promise<ApiModelDiscoveryResult> {
  switch (request.provider) {
    case "nvidia-nim":
      return discoverNvidiaNimModels(request, fetchImpl);
    case "google-ai-studio":
      return discoverGoogleAiStudioModels(request, fetchImpl);
    case "google-vertex":
      return discoverGoogleVertexModels(request, fetchImpl);
    case "openrouter":
      return discoverOpenRouterModels(request, fetchImpl);
    case "ollama":
      return discoverOllamaModels(request, fetchImpl);
  }
}
