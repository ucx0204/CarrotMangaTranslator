import type {
  ApiModelDiscoveryRequest,
  ApiModelDiscoveryResult,
} from "../shared/apiProviderPresets";
import {
  discoverNvidiaNimModels,
  discoverOpenRouterModels,
} from "./apiModelDiscoveryCatalogs";
import type { FetchLike } from "./apiModelDiscoveryCommon";
import {
  discoverGoogleAiStudioModels,
  discoverGoogleVertexModels,
} from "./apiModelDiscoveryGoogle";

export async function discoverApiModels(
  request: ApiModelDiscoveryRequest,
  fetchImpl: FetchLike = fetch,
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
    const result = await dispatchApiModelDiscovery(request, deadlineFetch);
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
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
  }
}
